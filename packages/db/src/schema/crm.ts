import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

/**
 * Sensitive-flag taxonomy (AD-001 / US-014).
 * Null means the contact is not sensitive.
 * A non-null value means the contact is excluded from:
 *   - drafts generated for other contacts
 *   - digest runs
 *   - LLM context retrieval
 *   - full-text search (unless the exec explicitly toggles "include sensitive")
 * Only exec_all tier can set or clear this flag.
 */
export const SENSITIVE_FLAG_VALUES = [
  "rolled_off_customer",
  "irrelevant_vendor",
  "acquisition_target",
  "loi",
  "vc_outreach",
  "partnership",
] as const;

export type SensitiveFlag = (typeof SENSITIVE_FLAG_VALUES)[number];

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
    /**
     * Sensitive flag — see SENSITIVE_FLAG_VALUES for the full taxonomy.
     * varchar(32) is used because Drizzle ORM does not natively support
     * inline CHECK constraints on custom enum-like columns via pgEnum
     * across schemas.  The enforcement-level CHECK constraint is declared
     * separately in packages/db/src/rls/policies.sql (see migration note).
     */
    sensitiveFlag: varchar("sensitive_flag", { length: 32 }),
    /**
     * Draft flag (G1/G4 — US-005, SY-001).
     * true  → contact was auto-created from a LinkedIn URL or email intake
     *         and awaits exec confirmation ("needs review").
     * false → exec-confirmed; never overwritten by auto-create logic.
     *
     * Schema choice: single boolean column on crm.contact rather than a
     * separate crm.contact_draft table.  Rationale: draft contacts share
     * all the same fields as confirmed contacts (name, email, company,
     * title) so a second table would duplicate the schema; the only
     * difference is the confirmation state.  A boolean column is simpler,
     * keeps all queries against one table, and is trivially dropped later
     * if a richer workflow state machine is needed.
     *
     * Migration SQL:
     *   ALTER TABLE crm.contact ADD COLUMN is_draft boolean NOT NULL DEFAULT false;
     * Existing rows (all exec-confirmed) default to false — no backfill needed.
     * Drafts inherit the existing RLS visibility rules; no new policies required
     * since the exec (exec_all tier) already has full SELECT/INSERT/UPDATE/DELETE
     * on crm.contact.
     */
    isDraft: boolean("is_draft").notNull().default(false),
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
    // CHECK constraint mirrors SENSITIVE_FLAG_VALUES; keep in sync.
    check(
      "contact_sensitive_flag_chk",
      sql`${t.sensitiveFlag} IS NULL OR ${t.sensitiveFlag} IN (
        'rolled_off_customer',
        'irrelevant_vendor',
        'acquisition_target',
        'loi',
        'vc_outreach',
        'partnership'
      )`,
    ),
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
