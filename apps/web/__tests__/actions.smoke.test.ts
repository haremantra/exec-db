import { afterEach, describe, expect, it, vi } from "vitest";

const DEV_USER = "00000000-0000-0000-0000-000000000001";
const OTHER_USER = "00000000-0000-0000-0000-000000000099";

type Captured = {
  inserts: Array<{ table: string; values: unknown }>;
  updates: Array<{ table: string; set: unknown; where?: unknown }>;
  selects: Array<{ table: string }>;
  redirected: string | null;
  revalidated: string[];
};

function makeCaptured(): Captured {
  return { inserts: [], updates: [], selects: [], redirected: null, revalidated: [] };
}

let captured: Captured = makeCaptured();
let nextSelectResult: unknown[] = [];

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

afterEach(() => {
  captured = makeCaptured();
  nextSelectResult = [];
  vi.clearAllMocks();
});

async function runRedirecting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== "__redirect__") throw e;
  }
}

describe("crm contact actions", () => {
  it("createContact rejects without fullName/email", async () => {
    const { createContact } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    await expect(createContact(fd)).rejects.toThrow(/fullName and primaryEmail/);
    expect(captured.inserts).toHaveLength(0);
  });

  it("createContact inserts and redirects on success", async () => {
    const { createContact } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("fullName", "Test User");
    fd.set("primaryEmail", "test@example.com");
    fd.set("company", "Acme");
    fd.set("roleTitle", "PM");

    await runRedirecting(() => createContact(fd));

    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.table).toContain("contact");
    expect(captured.redirected).toMatch(/^\/crm\/contacts\//);
    expect(captured.revalidated).toContain("/crm/contacts");
  });

  it("addCallNote rejects empty markdown", async () => {
    const { addCallNote } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("markdown", "   ");
    await expect(
      addCallNote("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", fd),
    ).rejects.toThrow(/markdown is required/);
  });

  it("addCallNote inserts a row when markdown is present", async () => {
    const { addCallNote } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("markdown", "## A note\n\n- bullet");

    await addCallNote("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", fd);

    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.table).toContain("call_note");
  });

  it("updateCallNote rejects when not the author", async () => {
    nextSelectResult = [{ createdAt: new Date(), authorId: OTHER_USER }];
    const { updateCallNote } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("markdown", "edited");
    await expect(
      updateCallNote(
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        fd,
      ),
    ).rejects.toThrow(/only the author/);
    expect(captured.updates).toHaveLength(0);
  });

  it("updateCallNote rejects after the 24h window", async () => {
    nextSelectResult = [
      { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), authorId: DEV_USER },
    ];
    const { updateCallNote } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("markdown", "edited");
    await expect(
      updateCallNote(
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        fd,
      ),
    ).rejects.toThrow(/edit window expired/);
    expect(captured.updates).toHaveLength(0);
  });

  it("updateCallNote updates within window for the author", async () => {
    nextSelectResult = [
      { createdAt: new Date(Date.now() - 60 * 1000), authorId: DEV_USER },
    ];
    const { updateCallNote } = await import("../app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("markdown", "edited body");

    await updateCallNote(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      fd,
    );

    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.table).toContain("call_note");
    expect(captured.updates[0]!.set).toMatchObject({ markdown: "edited body" });
  });

  it("discardDraft sets status to discarded", async () => {
    const { discardDraft } = await import("../app/crm/contacts/actions");
    await discardDraft(
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.table).toContain("draft");
    expect(captured.updates[0]!.set).toMatchObject({ status: "discarded", decidedBy: DEV_USER });
  });
});

describe("pm project/task actions", () => {
  it("createProject rejects without name", async () => {
    const { createProject } = await import("../app/pm/projects/actions");
    await expect(createProject(new FormData())).rejects.toThrow(/name is required/);
  });

  it("createProject inserts and redirects", async () => {
    const { createProject } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("name", "Q3 OKRs");
    await runRedirecting(() => createProject(fd));

    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.table).toContain("project");
    expect(captured.redirected).toMatch(/^\/pm\/projects\//);
  });

  it("createTask rejects without title", async () => {
    const { createTask } = await import("../app/pm/projects/actions");
    await expect(
      createTask("dddddddd-dddd-dddd-dddd-dddddddddddd", new FormData()),
    ).rejects.toThrow(/title is required/);
  });

  it("createTask clamps priority into [0,10]", async () => {
    const { createTask } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("title", "ship it");
    fd.set("priority", "999");

    await createTask("dddddddd-dddd-dddd-dddd-dddddddddddd", fd);

    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.values).toMatchObject({ priority: 10 });
  });

  it("updateTaskStatus sets completedAt when done", async () => {
    const { updateTaskStatus } = await import("../app/pm/projects/actions");
    await updateTaskStatus(
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      "done",
    );
    expect(captured.updates).toHaveLength(1);
    const set = captured.updates[0]!.set as { status: string; completedAt: Date | null };
    expect(set.status).toBe("done");
    expect(set.completedAt).toBeInstanceOf(Date);
  });

  it("updateTaskStatus clears completedAt when not done", async () => {
    const { updateTaskStatus } = await import("../app/pm/projects/actions");
    await updateTaskStatus(
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      "in_progress",
    );
    const set = captured.updates[0]!.set as { status: string; completedAt: Date | null };
    expect(set.status).toBe("in_progress");
    expect(set.completedAt).toBeNull();
  });
});
