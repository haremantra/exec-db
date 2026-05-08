/**
 * priority-shifters.test.ts — Vitest suite for Stream Q (SY-014 / W8.2).
 *
 * 9 tests:
 *  1. customer_complaint fires on keyword + customer-domain sender.
 *  2. customer_complaint does NOT fire on keyword + non-customer sender.
 *  3. competitor_mention fires when COMPETITOR_DOMAINS is set and domain appears in body.
 *  4. competitor_mention does NOT fire when COMPETITOR_DOMAINS is empty/unset.
 *  5. Detection is case-insensitive (keyword, domain).
 *  6. Results are capped at 20.
 *  7. competitor_mention fires on generic "we're going with" phrase (no env var needed).
 *  8. competitor_mention fires on "switched to" phrase.
 *  9. Invariant #6 — dashboard still renders exactly 5 swimlane markers in page.tsx
 *     (static text check: the swimlane comment lists the 5 swimlane names).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Drizzle-orm stub ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __type: "and", args }),
  gte: (_col: unknown, _val: unknown) => ({ __type: "gte", col: _col, val: _val }),
  desc: (_col: unknown) => ({ __type: "desc", col: _col }),
  isNull: (_col: unknown) => ({ __type: "isNull", col: _col }),
  isNotNull: (_col: unknown) => ({ __type: "isNotNull", col: _col }),
  sql: (parts: TemplateStringsArray, ...vals: unknown[]) => ({
    __type: "sql",
    parts,
    vals,
  }),
}));

// ── @exec-db/db stub ──────────────────────────────────────────────────────────
function makeTable(name: string, schemaName: string) {
  const nameSym = Symbol.for("drizzle:Name");
  const schemaSym = Symbol.for("drizzle:Schema");
  const t: Record<symbol | string, unknown> = {};
  t[nameSym] = name;
  t[schemaSym] = schemaName;
  // Simulate column accessors as objects so sql`` templates can reference them.
  return new Proxy(t, {
    get(target, prop) {
      if (typeof prop === "symbol") return target[prop];
      if (prop in target) return target[prop];
      return { __col: `${schemaName}.${name}.${prop}` };
    },
  });
}

vi.mock("@exec-db/db", () => ({
  schema: {
    emailThread: makeTable("email_thread", "crm"),
    contact: makeTable("contact", "crm"),
    customerDim: makeTable("customer_dim", "core"),
  },
}));

// ── @/lib/db stub ─────────────────────────────────────────────────────────────
// We maintain a callCount so tests can distinguish the three sequential
// query() calls (email threads, contact companies, customer_dim domains).

type EmailThreadRow = {
  id: string;
  contactId: string | null;
  subject: string | null;
  snippet: string | null;
  bodyFull: string | null;
  lastMessageAt: Date;
  contactCompany: string | null;
};
type ContactCompanyRow = { company: string | null };
type CustomerDimRow = { domain: string | null };

let threadRows: EmailThreadRow[] = [];
let contactCompanyRows: ContactCompanyRow[] = [];
let customerDimRows: CustomerDimRow[] = [];

vi.mock("@/lib/db", () => ({
  query: vi.fn(
    async (
      _session: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => {
      // Build a minimal Drizzle-like chain that resolves to the right fixture
      // array based on which table the query targets.
      let targetTable = "";

      const chain = {
        select(_fields: unknown) {
          return chain;
        },
        from(table: unknown) {
          // Identify by the drizzle:Name symbol.
          const nameSym = Object.getOwnPropertySymbols(table as object).find((s) =>
            s.toString().includes("Name"),
          );
          if (nameSym) targetTable = String((table as Record<symbol, string>)[nameSym]);
          return chain;
        },
        leftJoin(_t: unknown, _cond: unknown) {
          return chain;
        },
        where(_cond: unknown) {
          return chain;
        },
        orderBy(_col: unknown) {
          return chain;
        },
        limit(_n: number) {
          return chain;
        },
        // Terminal: resolve based on targetTable
        then(resolve: (v: unknown) => unknown) {
          if (targetTable === "email_thread") return resolve(threadRows);
          if (targetTable === "contact") return resolve(contactCompanyRows);
          if (targetTable === "customer_dim") return resolve(customerDimRows);
          return resolve([]);
        },
      };

      // Make chain thenable so await works at the call site.
      return fn(chain);
    },
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION = { userId: "user-1", tier: "exec_all" as const, functionArea: null };

function makeThread(overrides: Partial<EmailThreadRow>): EmailThreadRow {
  return {
    id: overrides.id ?? "thread-1",
    contactId: overrides.contactId ?? "contact-1",
    subject: overrides.subject ?? "Hello",
    snippet: overrides.snippet ?? "",
    bodyFull: overrides.bodyFull ?? "",
    lastMessageAt: overrides.lastMessageAt ?? new Date(),
    contactCompany: overrides.contactCompany ?? null,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  threadRows = [];
  contactCompanyRows = [];
  customerDimRows = [];
  delete process.env.COMPETITOR_DOMAINS;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.COMPETITOR_DOMAINS;
});

// ── Import after mocks ────────────────────────────────────────────────────────
const { detectPriorityShifters } = await import(
  "@/lib/priority-shifters"
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("detectPriorityShifters", () => {
  it("1. flags customer_complaint when keyword + customer-domain sender match", async () => {
    threadRows = [
      makeThread({
        subject: "Issue with login",
        bodyFull: "I am frustrated with the product, this is unacceptable.",
        contactCompany: "Acme Corp",
      }),
    ];
    contactCompanyRows = [{ company: "Acme Corp" }];

    const results = await detectPriorityShifters(SESSION);

    expect(results).toHaveLength(1);
    const first = results[0]!;
    expect(first.kind).toBe("customer_complaint");
    expect(first.threadId).toBe("thread-1");
  });

  it("2. does NOT flag customer_complaint when keyword matches but sender is not a customer", async () => {
    threadRows = [
      makeThread({
        subject: "Your invoice",
        bodyFull: "I am disappointed with my order.",
        contactCompany: "Random Spam Co",
      }),
    ];
    // No customer rows — Random Spam Co is not a known customer.
    contactCompanyRows = [];
    customerDimRows = [];

    const results = await detectPriorityShifters(SESSION);

    const complaints = results.filter((r) => r.kind === "customer_complaint");
    expect(complaints).toHaveLength(0);
  });

  it("3. flags competitor_mention when COMPETITOR_DOMAINS is set and domain appears in body", async () => {
    process.env.COMPETITOR_DOMAINS = "rival.io,acme-alt.com";
    threadRows = [
      makeThread({
        subject: "Checking options",
        bodyFull: "We have been evaluating rival.io for our use case.",
      }),
    ];

    const results = await detectPriorityShifters(SESSION);

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("competitor_mention");
  });

  it("4. does NOT flag competitor_mention when COMPETITOR_DOMAINS is empty", async () => {
    // Ensure env var is NOT set.
    delete process.env.COMPETITOR_DOMAINS;
    threadRows = [
      makeThread({
        subject: "Vendor selection",
        bodyFull:
          "We are looking at several options including rival.io and acme-alt.com.",
      }),
    ];

    const results = await detectPriorityShifters(SESSION);

    const mentions = results.filter((r) => r.kind === "competitor_mention");
    expect(mentions).toHaveLength(0);
  });

  it("5. detection is case-insensitive (keyword in UPPER, domain in UPPER)", async () => {
    process.env.COMPETITOR_DOMAINS = "Rival.IO";
    threadRows = [
      // Complaint: keyword in caps, company mixed-case
      makeThread({
        id: "thread-complaint",
        subject: "CANCEL my subscription",
        bodyFull: "FRUSTRATED with your service.",
        contactCompany: "ACME CORP",
      }),
      // Competitor: domain in body as upper-case
      makeThread({
        id: "thread-competitor",
        subject: "Vendor review",
        bodyFull: "We are evaluating RIVAL.IO for this project.",
        contactCompany: null,
      }),
    ];
    contactCompanyRows = [{ company: "ACME CORP" }];

    const results = await detectPriorityShifters(SESSION);

    const complaint = results.find((r) => r.threadId === "thread-complaint");
    expect(complaint?.kind).toBe("customer_complaint");

    const mention = results.find((r) => r.threadId === "thread-competitor");
    expect(mention?.kind).toBe("competitor_mention");
  });

  it("6. results are capped at 20", async () => {
    // Populate 30 threads that all match the competitor_mention phrase.
    process.env.COMPETITOR_DOMAINS = "rival.io";
    threadRows = Array.from({ length: 30 }, (_, i) =>
      makeThread({
        id: `thread-${i}`,
        bodyFull: "We are going with rival.io instead.",
      }),
    );

    const results = await detectPriorityShifters(SESSION);

    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("7. flags competitor_mention on 'we're going with' phrase (no env var)", async () => {
    // No COMPETITOR_DOMAINS — generic phrase still triggers.
    threadRows = [
      makeThread({
        subject: "Decision made",
        bodyFull: "After reviewing options, we're going with another vendor.",
      }),
    ];

    const results = await detectPriorityShifters(SESSION);

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("competitor_mention");
  });

  it("8. flags competitor_mention on 'switched to' phrase", async () => {
    threadRows = [
      makeThread({
        subject: "Update on tooling",
        bodyFull: "Our team switched to a different platform last week.",
      }),
    ];

    const results = await detectPriorityShifters(SESSION);

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("competitor_mention");
  });
});

describe("Invariant #6 — 5-swimlane invariant (static guard)", () => {
  it("9. dashboard page.tsx still declares the five canonical swimlane names", async () => {
    // Read the source of dashboard/page.tsx as a string and verify the five
    // swimlane names from US-017 / W6.6 are present.  This is a static-text
    // guard so a future edit that accidentally removes a swimlane will be caught.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const filePath = path.resolve(
      __dirname,
      "../app/dashboard/page.tsx",
    );
    const src = await fs.readFile(filePath, "utf8");

    const swimlanes = [
      "prospects_followup",
      "inbox_progress",
      "admin",
      "thought_leadership",
      "product_roadmap",
    ];

    for (const lane of swimlanes) {
      expect(src, `Missing swimlane marker: ${lane}`).toContain(lane);
    }
  });
});
