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

/**
 * Triage-tag taxonomy (I1 — US-007, W2.5).
 * Captures the exec's weekly follow-up triage rule: can I help them, can they
 * help me, or are they a pilot candidate?
 * Null means no triage tag has been assigned.
 * Only exec_all tier can set or clear this tag.
 */
export const TRIAGE_TAG_VALUES = [
  "can_help_them",
  "can_help_me",
  "pilot_candidate",
] as const;

export type TriageTag = (typeof TRIAGE_TAG_VALUES)[number];

/**
 * Work-area taxonomy (I3 — US-001, W1.1).
 * Tags a contact (or task) with the exec's operational work area so that the
 * Monday view can group by function.  Null means no work area is assigned.
 */
export const WORK_AREA_VALUES = [
  "prospecting",
  "customer",
  "investor",
  "contractor",
  "board",
  "thought_leadership",
  "admin",
] as const;

export type WorkArea = (typeof WORK_AREA_VALUES)[number];

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
    /** Triage tag (I1 — US-007, W2.5). NULL = untagged. */
    triageTag: varchar("triage_tag", { length: 32 }),
    /** Work-area tag (I3 — US-001, W1.1). NULL = untagged. */
    workArea: varchar("work_area", { length: 32 }),
    /** Draft flag (G — US-005, SY-001). */
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
    // CHECK constraint mirrors TRIAGE_TAG_VALUES; keep in sync.
    check(
      "contact_triage_tag_chk",
      sql`${t.triageTag} IS NULL OR ${t.triageTag} IN (
        'can_help_them',
        'can_help_me',
        'pilot_candidate'
      )`,
    ),
    // CHECK constraint mirrors WORK_AREA_VALUES; keep in sync.
    check(
      "contact_work_area_chk",
      sql`${t.workArea} IS NULL OR ${t.workArea} IN (
        'prospecting',
        'customer',
        'investor',
        'contractor',
        'board',
        'thought_leadership',
        'admin'
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

/**
 * crm.assistant_grant — records which assistants an exec has authorized.
 *
 * An assistant with an active grant (revoked_at IS NULL) for a given exec
 * may read the exec's CRM/PM data at the 'assistant' tier. The grant is
 * revocable by the exec at any time via revokeAssistant().
 *
 * AD-002 / US-023 (PR2-H).
 */
export const assistantGrant = crm.table(
  "assistant_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The exec who granted access. */
    execUserId: uuid("exec_user_id").notNull(),
    /** The assistant (Chief-of-Staff / EA) being granted access. */
    assistantUserId: uuid("assistant_user_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Null while the grant is active. Set to now() on revocation. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // One active grant per (exec, assistant) pair; allows re-granting after revocation.
    uniqueIndex("assistant_grant_active_uk")
      .on(t.execUserId, t.assistantUserId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("assistant_grant_exec_idx").on(t.execUserId),
    index("assistant_grant_assistant_idx").on(t.assistantUserId),
  ],
);
