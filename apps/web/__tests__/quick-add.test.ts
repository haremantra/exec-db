/**
 * Tests for G1-G4: LinkedIn quick-add + email intake (US-005, SY-001).
 *
 * Covers:
 *  1. quickAddFromLinkedIn rejects non-LinkedIn URLs
 *  2. quickAddFromLinkedIn extracts name from hyphenated slug (Title Case)
 *  3. quickAddFromLinkedIn creates a row with isDraft=true
 *  4. Email-intake route requires X-Intake-Secret and rejects without it
 *  5. Email-intake route creates a draft contact (isDraft=true)
 *  6. Email-intake route is idempotent: same primary_email → {existing:true}, no duplicate
 *  7. Email-intake route never updates/overwrites a confirmed (isDraft=false) row
 *  8. Signature parsing extracts company from email domain when no signature line matches
 *  9. extractTitle returns a match on a known title keyword
 * 10. slugToName handles single-word slugs (no hyphens)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const DEV_USER = "00000000-0000-0000-0000-000000000001";

type Captured = {
  inserts: Array<{ table: string; values: unknown }>;
  updates: Array<{ table: string; set: unknown; where?: unknown }>;
  deletes: Array<{ table: string }>;
  selects: Array<{ table: string }>;
  redirected: string | null;
  revalidated: string[];
};

function makeCaptured(): Captured {
  return {
    inserts: [],
    updates: [],
    deletes: [],
    selects: [],
    redirected: null,
    revalidated: [],
  };
}

let captured: Captured = makeCaptured();
/**
 * nextSelectResult is returned by the mock tx.select().from().where().limit()
 * chain. Set this before any test that needs the select to return existing rows.
 */
let nextSelectResult: unknown[] = [];

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    captured.revalidated.push(p);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    captured.redirected = p;
    throw new Error("__redirect__");
  },
  notFound: () => {
    throw new Error("__notFound__");
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: async () => ({
    userId: DEV_USER,
    email: "dev@exec-db.local",
    tier: "exec_all",
    functionArea: null,
  }),
}));

vi.mock("@/lib/db", () => ({
  query: async <T,>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    function tableName(target: unknown): string {
      const sym = Object.getOwnPropertySymbols(target as object).find((s) =>
        s.toString().includes("Name"),
      );
      const name =
        sym && (target as Record<symbol, unknown>)[sym]
          ? String((target as Record<symbol, unknown>)[sym])
          : "unknown";
      const schemaSym = Object.getOwnPropertySymbols(target as object).find((s) =>
        s.toString().includes("Schema"),
      );
      const sch = schemaSym ? String((target as Record<symbol, unknown>)[schemaSym]) : "";
      return sch ? `${sch}.${name}` : name;
    }

    const tx = {
      insert(table: unknown) {
        const t = tableName(table);
        return {
          values(values: unknown) {
            captured.inserts.push({ table: t, values });
            return {
              returning: async () => [{ id: "00000000-0000-0000-0000-00000000aaaa" }],
              then: (resolve: () => void) => Promise.resolve().then(resolve),
            };
          },
        };
      },
      update(table: unknown) {
        const t = tableName(table);
        const entry: { table: string; set: unknown; where?: unknown } = { table: t, set: null };
        captured.updates.push(entry);
        return {
          set(set: unknown) {
            entry.set = set;
            return {
              where(where: unknown) {
                entry.where = where;
                return Promise.resolve();
              },
            };
          },
        };
      },
      delete(table: unknown) {
        const t = tableName(table);
        captured.deletes.push({ table: t });
        return {
          where: (_where: unknown) => Promise.resolve(),
        };
      },
      select(_cols?: unknown) {
        return {
          from(table: unknown) {
            captured.selects.push({ table: tableName(table) });
            return {
              where() {
                return { limit: async () => nextSelectResult };
              },
            };
          },
        };
      },
    };
    return fn(tx);
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function runRedirecting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== "__redirect__") throw e;
  }
}

function makeRequest(
  body: unknown,
  secret: string | null = process.env.EMAIL_INTAKE_SECRET ?? "test-secret",
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["x-intake-secret"] = secret;
  return new NextRequest("http://localhost/api/intake/email", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.EMAIL_INTAKE_SECRET = "test-secret";
});

afterEach(() => {
  captured = makeCaptured();
  nextSelectResult = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// quickAddFromLinkedIn tests
// ---------------------------------------------------------------------------

describe("quickAddFromLinkedIn", () => {
  it("rejects non-LinkedIn URLs", async () => {
    const { quickAddFromLinkedIn } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("linkedinUrl", "https://twitter.com/alice");
    await expect(quickAddFromLinkedIn(fd)).rejects.toThrow(/Invalid LinkedIn URL/);
    expect(captured.inserts).toHaveLength(0);
  });

  it("rejects a URL that looks like LinkedIn but is missing the /in/ path", async () => {
    const { quickAddFromLinkedIn } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("linkedinUrl", "https://linkedin.com/company/acme");
    await expect(quickAddFromLinkedIn(fd)).rejects.toThrow(/Invalid LinkedIn URL/);
    expect(captured.inserts).toHaveLength(0);
  });

  it("extracts Title Case name from a hyphenated slug", async () => {
    const { quickAddFromLinkedIn } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("linkedinUrl", "https://linkedin.com/in/alice-doe");

    await runRedirecting(() => quickAddFromLinkedIn(fd));

    expect(captured.inserts).toHaveLength(1);
    const values = captured.inserts[0]!.values as { fullName: string };
    expect(values.fullName).toBe("Alice Doe");
  });

  it("creates the contact row with isDraft=true", async () => {
    const { quickAddFromLinkedIn } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("linkedinUrl", "https://www.linkedin.com/in/bob-smith/");

    await runRedirecting(() => quickAddFromLinkedIn(fd));

    expect(captured.inserts).toHaveLength(1);
    const values = captured.inserts[0]!.values as { isDraft: boolean };
    expect(values.isDraft).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// slugToName unit tests
// ---------------------------------------------------------------------------

describe("slugToName", () => {
  it("converts a single-word slug unchanged (capitalised first letter)", async () => {
    const { slugToName } = await import("../app/crm/contacts/actions");
    expect(slugToName("alice")).toBe("Alice");
  });

  it("converts multi-hyphen slug to Title Case", async () => {
    const { slugToName } = await import("../app/crm/contacts/actions");
    expect(slugToName("john-james-doe")).toBe("John James Doe");
  });
});

// ---------------------------------------------------------------------------
// Email intake route tests
// ---------------------------------------------------------------------------

describe("POST /api/intake/email", () => {
  it("returns 401 when X-Intake-Secret header is missing", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    const req = makeRequest({ from: { email: "alice@example.com" } }, null);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(captured.inserts).toHaveLength(0);
  });

  it("returns 401 when X-Intake-Secret is wrong", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    const req = makeRequest({ from: { email: "alice@example.com" } }, "wrong-secret");
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(captured.inserts).toHaveLength(0);
  });

  it("creates a draft contact (isDraft=true) when email is new", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    // nextSelectResult = [] means no existing contact
    const req = makeRequest({
      from: { name: "Carol Jones", email: "carol@startup.com" },
      subject: "Introduction",
      body: "Hi, I'm Carol.\n\nCEO\nStartup Inc\n+1 555 000 0000",
    });

    const res = await POST(req);
    const json = (await res.json()) as { created?: boolean };

    expect(res.status).toBe(200);
    expect(json.created).toBe(true);
    expect(captured.inserts).toHaveLength(1);
    const values = captured.inserts[0]!.values as {
      isDraft: boolean;
      primaryEmail: string;
      fullName: string;
    };
    expect(values.isDraft).toBe(true);
    expect(values.primaryEmail).toBe("carol@startup.com");
    expect(values.fullName).toBe("Carol Jones");
  });

  it("is idempotent: same email twice returns {existing:true} and does not insert", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    // Simulate existing contact in DB
    nextSelectResult = [{ id: "some-uuid", isDraft: false }];

    const req = makeRequest({
      from: { email: "carol@startup.com" },
    });

    const res = await POST(req);
    const json = (await res.json()) as { existing?: boolean };

    expect(res.status).toBe(200);
    expect(json.existing).toBe(true);
    expect(captured.inserts).toHaveLength(0);
  });

  it("never overwrites an exec-confirmed (isDraft=false) row", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    // A confirmed contact exists
    nextSelectResult = [{ id: "confirmed-uuid", isDraft: false }];

    const req = makeRequest({ from: { email: "confirmed@corp.com" } });
    await POST(req);

    // No insert, no update
    expect(captured.inserts).toHaveLength(0);
    expect(captured.updates).toHaveLength(0);
  });

  it("extracts company from email domain when no signature line matches", async () => {
    const { POST } = await import("../app/api/intake/email/route");
    const req = makeRequest({
      from: { email: "dave@widgets.com" },
      body: "Hello there!\n\nLet us connect.",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(captured.inserts).toHaveLength(1);
    const values = captured.inserts[0]!.values as { company: string | null };
    // Domain "widgets.com" → company "Widgets"
    expect(values.company).toBe("Widgets");
  });
});

// ---------------------------------------------------------------------------
// extractTitle unit tests (via named export)
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("returns a matched title from body text", async () => {
    const { extractTitle } = await import("../app/api/intake/email/route");
    const body = "Hello\n\nVP of Product\nAcme Corp";
    expect(extractTitle(body)).toMatch(/VP/i);
  });
});
