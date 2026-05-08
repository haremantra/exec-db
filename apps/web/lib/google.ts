/**
 * Google API client factory and OAuth helpers.
 *
 * All Google API access in this codebase must go through `googleClientForUser`.
 * Never instantiate google.auth.OAuth2 or google.auth anywhere else.
 *
 * Encryption: access/refresh tokens are stored as pgp_sym_encrypt(token, key)
 * bytea values. The key is GOOGLE_TOKEN_ENC_KEY from env.
 *
 * See docs/access-control.md § "OAuth token encryption".
 */
import { randomBytes } from "node:crypto";
import { google, type Auth } from "googleapis";
import { sql } from "drizzle-orm";
import { getDb } from "@exec-db/db";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoogleClient = Auth.OAuth2Client;

interface TokenRow {
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer;
  expiresAt: Date;
  scope: string[];
}

interface UpsertTokenParams {
  userId: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface BuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a cryptographically random state token for CSRF protection. */
export function generateStateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Build the Google OAuth2 authorization URL. */
export function buildGoogleAuthUrl({
  clientId,
  redirectUri,
  scopes,
  state,
}: BuildAuthUrlParams): string {
  const oauth2Client = new google.auth.OAuth2(clientId, undefined, redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token on every consent
    scope: scopes,
    state,
  });
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function getEncKey(): string {
  const key = process.env.GOOGLE_TOKEN_ENC_KEY;
  if (!key) throw new Error("GOOGLE_TOKEN_ENC_KEY env var is not set");
  return key;
}

function getRawDb() {
  const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_APP (or DATABASE_URL) is required");
  return getDb(url);
}

/**
 * Exchange an authorization code for tokens, fetch the user's Google email,
 * and upsert the encrypted row in crm.oauth_token.
 *
 * Sets is_of_record = true if this is the user's first Google account.
 */
export async function upsertOauthToken({
  userId,
  code,
  clientId,
  clientSecret,
  redirectUri,
}: UpsertTokenParams): Promise<void> {
  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Google did not return access_token or refresh_token");
    }

    oauth2Client.setCredentials(tokens);

    // Fetch the user's email via userinfo
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const accountEmail = userInfo.data.email;
    if (!accountEmail) throw new Error("Google userinfo did not return email");

    const encKey = getEncKey();
    const db = getRawDb();

    // Determine if this is the user's first Google account (sets is_of_record)
    // db.execute returns RowList which extends the rows array directly.
    const existingRows = await db.execute(
      sql`SELECT id FROM crm.oauth_token WHERE user_id = ${userId}::uuid AND provider = 'google'`,
    );
    const isFirstAccount = (existingRows as unknown[]).length === 0;

    const expiresAt = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    const scope: string[] = tokens.scope ? tokens.scope.split(" ") : [];

    // Upsert: ON CONFLICT (user_id, provider, account_email) DO UPDATE
    await db.execute(sql`
      INSERT INTO crm.oauth_token
        (user_id, provider, account_email, is_of_record,
         access_token_enc, refresh_token_enc, scope, expires_at,
         created_at, updated_at)
      VALUES (
        ${userId}::uuid,
        'google',
        ${accountEmail},
        ${isFirstAccount},
        pgp_sym_encrypt(${tokens.access_token}, ${encKey}),
        pgp_sym_encrypt(${tokens.refresh_token}, ${encKey}),
        ${scope}::text[],
        ${expiresAt.toISOString()}::timestamptz,
        now(),
        now()
      )
      ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
        access_token_enc = pgp_sym_encrypt(${tokens.access_token}, ${encKey}),
        refresh_token_enc = pgp_sym_encrypt(${tokens.refresh_token}, ${encKey}),
        scope = ${scope}::text[],
        expires_at = ${expiresAt.toISOString()}::timestamptz,
        updated_at = now()
    `);
  } catch (err) {
    console.error("[google] upsertOauthToken failed:", err);
    throw new Error(
      `Failed to store Google OAuth tokens: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Returns an authenticated googleapis client for the user's of-record Google account.
 *
 * Fetches the token from crm.oauth_token, decrypts via pgp_sym_decrypt,
 * refreshes if expired (updating the row), and returns a ready OAuth2Client.
 *
 * This is the ONLY function that should be used to obtain a Google API client.
 * Never instantiate google.auth.OAuth2 outside this file.
 */
export async function googleClientForUser(userId: string): Promise<GoogleClient> {
  try {
    const encKey = getEncKey();
    const db = getRawDb();

    const result = await db.execute(sql`
      SELECT
        pgp_sym_decrypt(access_token_enc, ${encKey}) AS access_token,
        pgp_sym_decrypt(refresh_token_enc, ${encKey}) AS refresh_token,
        expires_at,
        scope
      FROM crm.oauth_token
      WHERE user_id = ${userId}::uuid
        AND provider = 'google'
        AND is_of_record = true
      LIMIT 1
    `);

    // RowList extends the array directly — use index access
    const rows = result as unknown as Array<{
      access_token: string;
      refresh_token: string;
      expires_at: Date;
      scope: string[];
    }>;

    if (rows.length === 0) {
      throw new Error(`No of-record Google token found for user ${userId}`);
    }

    const row = rows[0]!;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Google OAuth env vars not configured");
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: new Date(row.expires_at).getTime(),
    });

    // Refresh if expired (with a 60-second buffer)
    const isExpired = new Date(row.expires_at).getTime() < Date.now() + 60_000;
    if (isExpired) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Persist new access token (refresh token remains the same)
      if (credentials.access_token && credentials.expiry_date) {
        await db.execute(sql`
          UPDATE crm.oauth_token SET
            access_token_enc = pgp_sym_encrypt(${credentials.access_token}, ${encKey}),
            expires_at = ${new Date(credentials.expiry_date).toISOString()}::timestamptz,
            updated_at = now()
          WHERE user_id = ${userId}::uuid
            AND provider = 'google'
            AND is_of_record = true
        `);
      }
    }

    return oauth2Client;
  } catch (err) {
    console.error("[google] googleClientForUser failed:", err);
    throw new Error(
      `Failed to get Google client for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Type guard to ensure no send usage slips in ──────────────────────────────
// AD-004: gmail.users.messages.send is explicitly forbidden.
// The CI lint check (stream J) will also enforce this.
