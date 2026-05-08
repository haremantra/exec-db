/**
 * Gmail sync and draft-creation helpers.
 *
 * AD-004 HARD CONSTRAINT: This file MUST NOT call or import
 * gmail.users.messages.send under any circumstances.
 * Only gmail.compose scope is used for drafts.
 *
 * Sync: pulls Gmail threads into crm.email_thread (idempotent on gmail_thread_id).
 * Draft: creates a draft via users.drafts.create — NEVER users.messages.send.
 */
import { google } from "googleapis";
import { sql } from "drizzle-orm";
import { getDb } from "@exec-db/db";
import { googleClientForUser } from "./google.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncGmailOptions {
  last?: number;
}

interface SyncGmailResult {
  ingested: number;
}

interface CreateDraftParams {
  to: string;
  subject: string;
  bodyMarkdown: string;
  threadId?: string;
}

interface CreateDraftResult {
  draftId: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default number of threads to pull per contact (S3.6). */
const DEFAULT_THREAD_LIMIT = 5;

// ─── Gmail sync ───────────────────────────────────────────────────────────────

/**
 * Syncs Gmail threads for a given contact email into crm.email_thread.
 *
 * Pulls the last N threads (default 5) matching the contact address.
 * Stores full thread body in body_full (S6.6 override) and snippet in snippet.
 * Idempotent on gmail_thread_id.
 */
export async function syncGmailForContact(
  userId: string,
  contactEmail: string,
  opts: SyncGmailOptions = {},
): Promise<SyncGmailResult> {
  try {
    const authClient = await googleClientForUser(userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gmail = google.gmail({ version: "v1", auth: authClient as any });
    const db = getRawDb();
    const limit = opts.last ?? DEFAULT_THREAD_LIMIT;

    // Query threads involving this contact
    const threadsResponse = await gmail.users.threads.list({
      userId: "me",
      q: `from:${contactEmail} OR to:${contactEmail}`,
      maxResults: limit,
    });

    const threadItems = threadsResponse.data.threads ?? [];
    let ingested = 0;

    // Resolve contactId from crm.contact
    // RowList extends the rows array directly — use index access.
    const contactResult = await db.execute(sql`
      SELECT id FROM crm.contact
      WHERE primary_email = ${contactEmail}
      LIMIT 1
    `);
    const contactRows = contactResult as unknown as Array<{ id: string }>;
    const contactId = contactRows.length > 0 ? contactRows[0]!.id : null;

    for (const threadItem of threadItems) {
      if (!threadItem.id) continue;

      // Fetch full thread to get messages + bodies
      const threadDetail = await gmail.users.threads.get({
        userId: "me",
        id: threadItem.id,
        format: "full",
      });

      const messages = threadDetail.data.messages ?? [];
      if (messages.length === 0) continue;

      // Extract subject from first message headers
      const firstMsg = messages[0]!;
      const headers = firstMsg.payload?.headers ?? [];
      const subject =
        headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? null;

      // Last message timestamp
      const lastInternalDate = messages[messages.length - 1]!.internalDate;
      const lastMessageAt = lastInternalDate
        ? new Date(parseInt(lastInternalDate, 10))
        : null;

      // Snippet from the thread listing
      const snippet = threadDetail.data.snippet ?? null;

      // Full body: concatenate plain-text parts from all messages
      const bodyFull = extractFullBody(messages);

      await db.execute(sql`
        INSERT INTO crm.email_thread
          (gmail_thread_id, contact_id, subject, last_message_at, snippet, body_full,
           _ingested_at, _source_system, _source_id, _valid_from)
        VALUES (
          ${threadItem.id},
          ${contactId}::uuid,
          ${subject},
          ${lastMessageAt?.toISOString() ?? null}::timestamptz,
          ${snippet},
          ${bodyFull},
          now(),
          'google_gmail',
          ${threadItem.id},
          now()
        )
        ON CONFLICT (gmail_thread_id) DO NOTHING
      `);

      ingested++;
    }

    return { ingested };
  } catch (err) {
    console.error(
      `[google-gmail] syncGmailForContact failed for contact ${contactEmail}:`,
      err,
    );
    throw new Error(
      `Gmail sync failed for user ${userId} / contact ${contactEmail}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ─── Gmail draft create ───────────────────────────────────────────────────────

/**
 * Creates a Gmail draft via gmail.compose scope.
 *
 * AD-004 ENFORCEMENT: This function calls users.drafts.create.
 * Do NOT add any call to users.messages.send — ever.
 * The gmail.send scope is NOT requested; calling send would fail at the API
 * layer and violate the invariant baked into the OAuth consent screen.
 *
 * @returns draftId — the Gmail draft ID (string).
 */
export async function createGmailDraft(
  userId: string,
  params: CreateDraftParams,
): Promise<CreateDraftResult> {
  try {
    const authClient = await googleClientForUser(userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gmail = google.gmail({ version: "v1", auth: authClient as any });

    const mimeMessage = buildMimeMessage(params);
    const encodedMessage = Buffer.from(mimeMessage).toString("base64url");

    const requestBody: {
      message: { raw: string; threadId?: string };
    } = {
      message: { raw: encodedMessage },
    };
    if (params.threadId) {
      requestBody.message.threadId = params.threadId;
    }

    // AD-004: uses drafts.create — NOT messages.send
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody,
    });

    const draftId = response.data.id;
    if (!draftId) throw new Error("Gmail API returned no draft ID");

    return { draftId };
  } catch (err) {
    console.error("[google-gmail] createGmailDraft failed:", err);
    throw new Error(
      `Gmail draft creation failed for user ${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Builds a minimal RFC 2822 MIME message suitable for Gmail's raw upload.
 * Body is sent as text/plain since the caller provides Markdown.
 */
function buildMimeMessage(params: CreateDraftParams): string {
  const { to, subject, bodyMarkdown, threadId } = params;
  const date = new Date().toUTCString();

  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
  ];

  if (threadId) {
    // Placing thread ID in a custom header for reference; Gmail handles threading via threadId param.
    headers.push(`X-Gmail-Thread-Id: ${threadId}`);
  }

  return `${headers.join("\r\n")}\r\n\r\n${bodyMarkdown}`;
}

/** Encode non-ASCII subjects per RFC 2047 (base64 encoding). */
function encodeSubject(subject: string): string {
  if (/[^\x00-\x7F]/.test(subject)) {
    return `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  }
  return subject;
}

type GmailMessagePart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailMessagePart[] | null;
};

type GmailMessage = {
  payload?: GmailMessagePart | null;
};

/**
 * Recursively extracts plain-text parts from all messages in a thread.
 * Returns a single concatenated string with message separators.
 */
function extractFullBody(messages: GmailMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (!msg.payload) continue;
    const text = extractTextFromPart(msg.payload);
    if (text) parts.push(text);
  }

  return parts.join("\n\n---\n\n");
}

function extractTextFromPart(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }

  if (part.parts && part.parts.length > 0) {
    for (const subPart of part.parts) {
      const text = extractTextFromPart(subPart);
      if (text) return text;
    }
  }

  return "";
}

function getRawDb() {
  const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_APP (or DATABASE_URL) is required");
  return getDb(url);
}
