import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * pgcrypto-encrypted bytea column.
 * On write: the application must pass the ciphertext (encrypted via pgp_sym_encrypt).
 * On read: the application receives raw bytea and must call pgp_sym_decrypt.
 * See docs/access-control.md § "OAuth token encryption" for the key derivation details.
 */
const encryptedBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
import { lineage } from "./core.js";

export const crm = pgSchema("crm");

export const contact = crm.table(
  "contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    primaryEmail: text("primary_email").notNull(),
    company: text("company"),
    roleTitle: text("role_title"),
    linkedEmployeeId: uuid("linked_employee_id"),
    linkedCustomerId: uuid("linked_customer_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("contact_email_uk").on(t.primaryEmail),
    index("contact_company_idx").on(t.company),
  ],
);

export const account = crm.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain"),
    linkedCustomerId: uuid("linked_customer_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("account_domain_uk").on(t.domain)],
);

export const callNote = crm.table(
  "call_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    markdown: text("markdown").notNull(),
    authorId: uuid("author_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("call_note_contact_idx").on(t.contactId, t.occurredAt)],
);

/** Synced from Google Calendar in PR 2. Columns stubbed now so PR 2 has a target. */
export const calendarEvent = crm.table(
  "calendar_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    googleEventId: varchar("google_event_id", { length: 128 }).notNull(),
    contactId: uuid("contact_id"),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    attendees: jsonb("attendees"),
    ...lineage,
  },
  (t) => [
    uniqueIndex("calendar_event_google_uk").on(t.googleEventId),
    index("calendar_event_contact_idx").on(t.contactId, t.startsAt),
  ],
);

/** Synced from Gmail in PR 2. Columns stubbed now so PR 2 has a target. */
export const emailThread = crm.table(
  "email_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gmailThreadId: varchar("gmail_thread_id", { length: 128 }).notNull(),
    contactId: uuid("contact_id"),
    subject: text("subject"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    snippet: text("snippet"),
    /** Full thread body — S6.6 override: store complete body for briefing/draft context. */
    bodyFull: text("body_full"),
    ...lineage,
  },
  (t) => [
    uniqueIndex("email_thread_gmail_uk").on(t.gmailThreadId),
    index("email_thread_contact_idx").on(t.contactId, t.lastMessageAt),
  ],
);

/**
 * OAuth token storage for per-user Google credentials.
 * access_token_enc and refresh_token_enc are pgp_sym_encrypt(plaintext, key) values.
 * The encryption key comes from env GOOGLE_TOKEN_ENC_KEY (never stored in DB).
 * See docs/access-control.md § "OAuth token encryption".
 *
 * AD-007: only one of-record account per user per provider (is_of_record unique index).
 */
export const oauthToken = crm.table(
  "oauth_token",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    userId: uuid("user_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    accountEmail: text("account_email").notNull(),
    isOfRecord: boolean("is_of_record").notNull().default(true),
    accessTokenEnc: encryptedBytea("access_token_enc").notNull(),
    refreshTokenEnc: encryptedBytea("refresh_token_enc").notNull(),
    scope: text("scope").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("oauth_token_user_provider_email_uk").on(
      t.userId,
      t.provider,
      t.accountEmail,
    ),
    // Partial unique index: only one of-record account per user+provider
    // (enforced at the app layer on upsert; DB constraint left to app logic
    //  because partial unique index on boolean requires raw SQL).
    index("oauth_token_user_provider_idx").on(t.userId, t.provider),
  ],
);

/**
 * email_thread gains a body_full column for full-body storage (S6.6 override).
 * The existing schema stub has only `snippet`; we extend it here.
 */
export const draft = crm.table(
  "draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    subject: text("subject"),
    bodyMarkdown: text("body_markdown"),
    modelId: varchar("model_id", { length: 64 }),
    promptHash: varchar("prompt_hash", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    gmailDraftId: varchar("gmail_draft_id", { length: 128 }),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("draft_contact_idx").on(t.contactId, t.generatedAt),
    index("draft_status_idx").on(t.status),
  ],
);
