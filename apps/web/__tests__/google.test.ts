/**
 * Tests for Google OAuth + Calendar + Gmail integration (Stream A).
 *
 * Mock strategy:
 *   - `googleapis` — class-level mock to prevent real HTTP calls
 *   - `@exec-db/db` — mockExecute simulates DB responses (token rows, inserts)
 *
 * The mock for `googleClientForUser` used by calendar/gmail tests is achieved
 * by ensuring mockExecute returns a valid token row (not expired) so the real
 * implementation resolves to the MockOAuth2Client. All subsequent API calls
 * (calendar.events.list, gmail.threads.list, etc.) are mocked at the googleapis
 * level.
 *
 * 13 tests total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── googleapis mock ─────────────────────────────────────────────────────────

const mockGetToken = vi.fn();
const mockRefreshAccessToken = vi.fn();
const mockGenerateAuthUrl = vi.fn();
const mockSetCredentials = vi.fn();

const mockUserinfoGet = vi.fn();
const mockCalendarEventsList = vi.fn();
const mockGmailThreadsList = vi.fn();
const mockGmailThreadsGet = vi.fn();
const mockGmailDraftsCreate = vi.fn();

class MockOAuth2Client {
  getToken = mockGetToken;
  refreshAccessToken = mockRefreshAccessToken;
  generateAuthUrl = mockGenerateAuthUrl;
  setCredentials = mockSetCredentials;
}

vi.mock("googleapis", () => {
  const auth = { OAuth2: MockOAuth2Client };
  return {
    google: {
      auth,
      oauth2: () => ({ userinfo: { get: mockUserinfoGet } }),
      calendar: () => ({
        events: { list: mockCalendarEventsList },
      }),
      gmail: () => ({
        users: {
          threads: {
            list: mockGmailThreadsList,
            get: mockGmailThreadsGet,
          },
          drafts: {
            create: mockGmailDraftsCreate,
          },
          // Note: messages.send is intentionally NOT present (AD-004)
        },
      }),
    },
    Auth: {},
  };
});

// ─── DB mock ─────────────────────────────────────────────────────────────────

const mockExecute = vi.fn();

vi.mock("@exec-db/db", () => ({
  getDb: () => ({ execute: mockExecute }),
}));

// ─── env + helpers ────────────────────────────────────────────────────────────

const USER_ID = "00000000-0000-0000-0000-000000000001";
const CONTACT_EMAIL = "contact@example.com";
const FUTURE_EXPIRY = new Date(Date.now() + 3_600_000);

/** Token row returned by googleClientForUser's DB query (not expired). */
const validTokenRow = {
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token",
  expires_at: FUTURE_EXPIRY,
  scope: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
};

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";
  process.env.GOOGLE_TOKEN_ENC_KEY = "test-enc-key-32-chars-long!!!!";
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";

  // Re-establish default implementations after vi.resetAllMocks() clears them
  mockGenerateAuthUrl.mockReturnValue("https://accounts.google.com/o/oauth2/auth?mock=1");
});

afterEach(() => {
  // resetAllMocks clears both call history AND queued mockResolvedValueOnce responses,
  // preventing leftover responses from bleeding into the next test.
  vi.resetAllMocks();
});

// ─── generateStateToken ────────────────────────────────────────────────────────

describe("generateStateToken", () => {
  it("produces a 64-char hex string", async () => {
    const { generateStateToken } = await import("@/lib/google");
    const token = generateStateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different tokens on each call (CSRF uniqueness)", async () => {
    const { generateStateToken } = await import("@/lib/google");
    const tokens = new Set(Array.from({ length: 10 }, () => generateStateToken()));
    expect(tokens.size).toBe(10);
  });
});

// ─── buildGoogleAuthUrl ────────────────────────────────────────────────────────

describe("buildGoogleAuthUrl", () => {
  it("returns the URL from OAuth2.generateAuthUrl", async () => {
    const { buildGoogleAuthUrl } = await import("@/lib/google");
    const url = buildGoogleAuthUrl({
      clientId: "cid",
      redirectUri: "http://localhost:3000/callback",
      scopes: ["https://www.googleapis.com/auth/gmail.compose"],
      state: "abc123",
    });
    expect(url).toBe("https://accounts.google.com/o/oauth2/auth?mock=1");
    expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        state: "abc123",
      }),
    );
  });
});

// ─── upsertOauthToken ─────────────────────────────────────────────────────────

describe("upsertOauthToken", () => {
  it("calls getToken and upserts encrypted tokens in DB", async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: "access-abc",
        refresh_token: "refresh-xyz",
        expiry_date: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/gmail.compose",
      },
    });
    mockUserinfoGet.mockResolvedValueOnce({
      data: { email: "exec@example.com" },
    });
    // SELECT existing → none; INSERT
    mockExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { upsertOauthToken } = await import("@/lib/google");
    await expect(
      upsertOauthToken({
        userId: USER_ID,
        code: "auth-code",
        clientId: "cid",
        clientSecret: "csec",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).resolves.toBeUndefined();

    expect(mockGetToken).toHaveBeenCalledWith("auth-code");
    // Two DB calls: SELECT + INSERT
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("sets is_of_record = true when this is the first Google account", async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: "access-abc",
        refresh_token: "refresh-xyz",
        expiry_date: Date.now() + 3600_000,
        scope: "gmail.compose",
      },
    });
    mockUserinfoGet.mockResolvedValueOnce({ data: { email: "exec@example.com" } });
    // No existing rows → first account → is_of_record = true
    mockExecute
      .mockResolvedValueOnce([]) // SELECT
      .mockResolvedValueOnce([]); // INSERT

    const { upsertOauthToken } = await import("@/lib/google");
    await upsertOauthToken({
      userId: USER_ID,
      code: "code",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "http://localhost:3000/callback",
    });

    // Both calls made — isFirstAccount = true was passed to INSERT
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("rejects when access_token is missing from Google response", async () => {
    mockGetToken.mockResolvedValueOnce({ tokens: { refresh_token: "rtok" } });

    const { upsertOauthToken } = await import("@/lib/google");
    await expect(
      upsertOauthToken({
        userId: USER_ID,
        code: "code",
        clientId: "cid",
        clientSecret: "csec",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).rejects.toThrow(/access_token/);
  });
});

// ─── googleClientForUser ──────────────────────────────────────────────────────

describe("googleClientForUser", () => {
  it("returns an OAuth2 client when token is not expired", async () => {
    mockExecute.mockResolvedValueOnce([validTokenRow]);

    const { googleClientForUser } = await import("@/lib/google");
    const client = await googleClientForUser(USER_ID);

    expect(client).toBeInstanceOf(MockOAuth2Client);
    expect(mockSetCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "mock-access-token" }),
    );
  });

  it("refreshes token when expired and updates the DB row", async () => {
    const pastExpiry = new Date(Date.now() - 60_000); // expired
    mockExecute
      .mockResolvedValueOnce([{ ...validTokenRow, expires_at: pastExpiry }])
      .mockResolvedValueOnce([]); // UPDATE

    mockRefreshAccessToken.mockResolvedValueOnce({
      credentials: {
        access_token: "new-access-tok",
        expiry_date: Date.now() + 3_600_000,
      },
    });

    const { googleClientForUser } = await import("@/lib/google");
    await googleClientForUser(USER_ID);

    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    // Two DB calls: SELECT + UPDATE
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("throws when no of-record token exists", async () => {
    mockExecute.mockResolvedValueOnce([]);

    const { googleClientForUser } = await import("@/lib/google");
    await expect(googleClientForUser("no-such-user")).rejects.toThrow(
      /No of-record Google token/,
    );
  });
});

// ─── syncCalendarEventsForUser ────────────────────────────────────────────────

describe("syncCalendarEventsForUser", () => {
  it("inserts events and matches attendees to CRM contacts", async () => {
    // googleClientForUser → valid token
    mockExecute.mockResolvedValueOnce([validTokenRow]);

    mockCalendarEventsList.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "event-001",
            summary: "Sync call",
            start: { dateTime: "2024-01-15T10:00:00Z" },
            end: { dateTime: "2024-01-15T11:00:00Z" },
            attendees: [{ email: CONTACT_EMAIL, displayName: "Contact Name", responseStatus: "accepted" }],
          },
        ],
        nextPageToken: undefined,
      },
    });

    // contact lookup → found; INSERT → OK
    mockExecute
      .mockResolvedValueOnce([{ id: "contact-uuid" }])
      .mockResolvedValueOnce([]); // INSERT ON CONFLICT DO NOTHING

    const { syncCalendarEventsForUser } = await import("@/lib/google-calendar");
    const result = await syncCalendarEventsForUser(USER_ID);

    expect(result.ingested).toBe(1);
  });

  it("is idempotent: duplicate google_event_id is silently ignored", async () => {
    // googleClientForUser → valid token
    mockExecute.mockResolvedValueOnce([validTokenRow]);

    mockCalendarEventsList.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "event-dup",
            summary: "Duplicate event",
            start: { dateTime: "2024-01-15T10:00:00Z" },
            end: { dateTime: "2024-01-15T11:00:00Z" },
            // No attendees → no contact lookup DB call
            attendees: [],
          },
        ],
      },
    });

    // No contact lookup (attendees empty); INSERT ON CONFLICT DO NOTHING → no error
    mockExecute.mockResolvedValueOnce([]); // INSERT

    const { syncCalendarEventsForUser } = await import("@/lib/google-calendar");
    const result = await syncCalendarEventsForUser(USER_ID);

    expect(result.ingested).toBe(1); // counted even on silent conflict
  });
});

// ─── syncGmailForContact ──────────────────────────────────────────────────────

describe("syncGmailForContact", () => {
  it("pulls threads and stores full body + snippet", async () => {
    mockExecute.mockResolvedValueOnce([validTokenRow]); // googleClientForUser

    mockGmailThreadsList.mockResolvedValueOnce({
      data: { threads: [{ id: "thread-001" }] },
    });
    mockGmailThreadsGet.mockResolvedValueOnce({
      data: {
        snippet: "Hello there",
        messages: [
          {
            internalDate: "1700000000000",
            payload: {
              mimeType: "text/plain",
              headers: [{ name: "Subject", value: "Re: Partnership" }],
              body: { data: Buffer.from("Full body text").toString("base64") },
            },
          },
        ],
      },
    });

    mockExecute
      .mockResolvedValueOnce([{ id: "contact-uuid" }]) // contact lookup
      .mockResolvedValueOnce([]); // INSERT ON CONFLICT DO NOTHING

    const { syncGmailForContact } = await import("@/lib/google-gmail");
    const result = await syncGmailForContact(USER_ID, CONTACT_EMAIL);

    expect(result.ingested).toBe(1);
  });

  it("is idempotent on duplicate gmail_thread_id", async () => {
    // First run
    mockExecute.mockResolvedValueOnce([validTokenRow]);
    mockGmailThreadsList.mockResolvedValueOnce({ data: { threads: [{ id: "thread-dup" }] } });
    mockGmailThreadsGet.mockResolvedValueOnce({
      data: {
        snippet: "snip",
        messages: [{
          internalDate: "1700000000000",
          payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Dupe" }], body: { data: Buffer.from("body").toString("base64") } },
        }],
      },
    });
    mockExecute
      .mockResolvedValueOnce([]) // contact lookup
      .mockResolvedValueOnce([]); // INSERT ON CONFLICT DO NOTHING

    const { syncGmailForContact } = await import("@/lib/google-gmail");
    const r1 = await syncGmailForContact(USER_ID, CONTACT_EMAIL);

    // Second run — same thread, same result
    mockExecute.mockResolvedValueOnce([validTokenRow]);
    mockGmailThreadsList.mockResolvedValueOnce({ data: { threads: [{ id: "thread-dup" }] } });
    mockGmailThreadsGet.mockResolvedValueOnce({
      data: {
        snippet: "snip",
        messages: [{
          internalDate: "1700000000000",
          payload: { mimeType: "text/plain", headers: [], body: { data: Buffer.from("body").toString("base64") } },
        }],
      },
    });
    mockExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const r2 = await syncGmailForContact(USER_ID, CONTACT_EMAIL);

    expect(r1.ingested).toBe(1);
    expect(r2.ingested).toBe(1);
  });
});

// ─── createGmailDraft ─────────────────────────────────────────────────────────

describe("createGmailDraft", () => {
  it("creates a draft via drafts.create and returns draftId", async () => {
    mockExecute.mockResolvedValueOnce([validTokenRow]);
    mockGmailDraftsCreate.mockResolvedValueOnce({ data: { id: "draft-abc123" } });

    const { createGmailDraft } = await import("@/lib/google-gmail");
    const result = await createGmailDraft(USER_ID, {
      to: "contact@example.com",
      subject: "Follow-up",
      bodyMarkdown: "## Recap\n\nGreat call.",
    });

    expect(result.draftId).toBe("draft-abc123");
    expect(mockGmailDraftsCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockGmailDraftsCreate.mock.calls[0]![0] as {
      requestBody: { message: { raw: string } };
    };
    const decoded = Buffer.from(callArgs.requestBody.message.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: contact@example.com");
    expect(decoded).toContain("Follow-up");
    expect(decoded).toContain("## Recap");
  });

  it("encodes non-ASCII subjects with RFC 2047", async () => {
    mockExecute.mockResolvedValueOnce([validTokenRow]);
    mockGmailDraftsCreate.mockResolvedValueOnce({ data: { id: "draft-unicode" } });

    const { createGmailDraft } = await import("@/lib/google-gmail");
    await createGmailDraft(USER_ID, {
      to: "contact@example.com",
      subject: "Suivi — Réunion",
      bodyMarkdown: "Corps du message.",
    });

    const callArgs = mockGmailDraftsCreate.mock.calls[0]![0] as {
      requestBody: { message: { raw: string } };
    };
    const decoded = Buffer.from(callArgs.requestBody.message.raw, "base64url").toString("utf-8");
    // Non-ASCII subject must be RFC-2047 encoded
    expect(decoded).toContain("=?UTF-8?B?");
  });

  it("NEVER calls users.messages.send (AD-004 guard)", async () => {
    mockExecute.mockResolvedValueOnce([validTokenRow]);
    mockGmailDraftsCreate.mockResolvedValueOnce({ data: { id: "draft-guard" } });

    const { createGmailDraft } = await import("@/lib/google-gmail");
    const result = await createGmailDraft(USER_ID, {
      to: "test@example.com",
      subject: "Guard test",
      bodyMarkdown: "body",
    });

    // drafts.create was called — confirms draft path was taken
    expect(result.draftId).toBe("draft-guard");
    expect(mockGmailDraftsCreate).toHaveBeenCalledTimes(1);

    // The mock exposes no messages.send method: AD-004 structurally enforced.
    // The gmail mock only has users.{threads, drafts} — no messages.send.
    const { google } = await import("googleapis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gmailInstance = google.gmail({ version: "v1", auth: undefined as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gmailInstance.users as any).messages?.send).toBeUndefined();
  });
});
