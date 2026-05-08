/**
 * K1-K4 task ergonomics tests (US-021, US-004, US-019, US-018).
 *
 * Verifies:
 *   - setTaskImpact requires exec_all tier
 *   - setTaskImpact rejects invalid impact values
 *   - setTaskImpact clears impact on "none"
 *   - setTaskPinned toggles correctly for exec_all
 *   - setTaskPinned requires exec_all tier
 *   - updateTaskStatus accepts "stuck" as a valid new status
 *   - updateTaskStatus rejects unknown status values
 *   - setProjectType requires exec_all tier
 *   - setProjectType rejects invalid project_type values
 *   - setProjectType clears project_type on "none"
 *   - IMPACT_VALUES, PROJECT_TYPE_VALUES, TASK_STATUS_VALUES export correctly
 */

import { IMPACT_VALUES, PROJECT_TYPE_VALUES, TASK_STATUS_VALUES } from "@exec-db/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEV_USER = "00000000-0000-0000-0000-000000000001";

type Captured = {
  updates: Array<{ table: string; set: unknown }>;
  revalidated: string[];
};

function makeCaptured(): Captured {
  return { updates: [], revalidated: [] };
}

let captured: Captured = makeCaptured();
let mockTier: string = "exec_all";

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
    throw new Error(`__redirect__:${p}`);
  },
  notFound: () => {
    throw new Error("__notFound__");
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: async () => ({
    userId: DEV_USER,
    email: "dev@exec-db.local",
    tier: mockTier,
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
            return {
              returning: async () => [{ id: "00000000-0000-0000-0000-00000000aaaa" }],
              then: (resolve: () => void) => Promise.resolve().then(resolve),
            };
          },
        };
      },
      update(table: unknown) {
        const t = tableName(table);
        const entry: { table: string; set: unknown } = { table: t, set: null };
        captured.updates.push(entry);
        return {
          set(set: unknown) {
            entry.set = set;
            return {
              where(_where: unknown) {
                return Promise.resolve();
              },
            };
          },
        };
      },
      select(_cols?: unknown) {
        return {
          from(table: unknown) {
            return {
              where() {
                return { limit: async () => [] };
              },
            };
          },
        };
      },
    };
    return fn(tx);
  },
}));

const TASK_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const PROJECT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

afterEach(() => {
  captured = makeCaptured();
  mockTier = "exec_all";
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Exported const arrays (no mocking needed)
// ---------------------------------------------------------------------------
describe("exported taxonomy arrays", () => {
  it("IMPACT_VALUES contains all four values", () => {
    expect(IMPACT_VALUES).toEqual(["revenue", "reputation", "both", "neither"]);
  });

  it("TASK_STATUS_VALUES includes stuck", () => {
    expect(TASK_STATUS_VALUES).toContain("stuck");
    expect(TASK_STATUS_VALUES).toContain("blocked");
    expect(TASK_STATUS_VALUES).toHaveLength(5);
  });

  it("PROJECT_TYPE_VALUES includes all seven types", () => {
    expect(PROJECT_TYPE_VALUES).toContain("sales_call");
    expect(PROJECT_TYPE_VALUES).toContain("licensing");
    expect(PROJECT_TYPE_VALUES).toContain("board_prep");
    expect(PROJECT_TYPE_VALUES).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// setTaskImpact (K1)
// ---------------------------------------------------------------------------
describe("setTaskImpact", () => {
  it("requires exec_all — rejects function_lead", async () => {
    mockTier = "function_lead";
    const { setTaskImpact } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("impact", "revenue");
    await expect(setTaskImpact(TASK_ID, PROJECT_ID, fd)).rejects.toThrow(/exec_all required/);
    expect(captured.updates).toHaveLength(0);
  });

  it("rejects invalid impact value", async () => {
    const { setTaskImpact } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("impact", "profit"); // not in IMPACT_VALUES
    await expect(setTaskImpact(TASK_ID, PROJECT_ID, fd)).rejects.toThrow(/Invalid impact/);
    expect(captured.updates).toHaveLength(0);
  });

  it("sets impact to 'revenue' for exec_all", async () => {
    const { setTaskImpact } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("impact", "revenue");
    await setTaskImpact(TASK_ID, PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ impact: "revenue" });
  });

  it("clears impact when value is 'none'", async () => {
    const { setTaskImpact } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("impact", "none");
    await setTaskImpact(TASK_ID, PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ impact: null });
  });
});

// ---------------------------------------------------------------------------
// setTaskPinned (K2)
// ---------------------------------------------------------------------------
describe("setTaskPinned", () => {
  it("requires exec_all — rejects manager", async () => {
    mockTier = "manager";
    const { setTaskPinned } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("pinned", "true");
    await expect(setTaskPinned(TASK_ID, PROJECT_ID, fd)).rejects.toThrow(/exec_all required/);
    expect(captured.updates).toHaveLength(0);
  });

  it("pins a task when pinned=true", async () => {
    const { setTaskPinned } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("pinned", "true");
    await setTaskPinned(TASK_ID, PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ isPinned: true });
  });

  it("unpins a task when pinned=false", async () => {
    const { setTaskPinned } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("pinned", "false");
    await setTaskPinned(TASK_ID, PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ isPinned: false });
  });
});

// ---------------------------------------------------------------------------
// updateTaskStatus — stuck (K3)
// ---------------------------------------------------------------------------
describe("updateTaskStatus with stuck", () => {
  it("accepts 'stuck' as a valid status", async () => {
    const { updateTaskStatus } = await import("../app/pm/projects/actions");
    await updateTaskStatus(TASK_ID, PROJECT_ID, "stuck");
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ status: "stuck", completedAt: null });
  });

  it("rejects an unknown status value", async () => {
    const { updateTaskStatus } = await import("../app/pm/projects/actions");
    await expect(
      // @ts-expect-error intentional invalid value for test
      updateTaskStatus(TASK_ID, PROJECT_ID, "wontfix"),
    ).rejects.toThrow(/Invalid status/);
    expect(captured.updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setProjectType (K4)
// ---------------------------------------------------------------------------
describe("setProjectType", () => {
  it("requires exec_all — rejects employee", async () => {
    mockTier = "employee";
    const { setProjectType } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("project_type", "deal");
    await expect(setProjectType(PROJECT_ID, fd)).rejects.toThrow(/exec_all required/);
    expect(captured.updates).toHaveLength(0);
  });

  it("rejects invalid project_type value", async () => {
    const { setProjectType } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("project_type", "sprint"); // not in PROJECT_TYPE_VALUES
    await expect(setProjectType(PROJECT_ID, fd)).rejects.toThrow(/Invalid project_type/);
    expect(captured.updates).toHaveLength(0);
  });

  it("sets project_type to 'licensing' for exec_all", async () => {
    const { setProjectType } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("project_type", "licensing");
    await setProjectType(PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ projectType: "licensing" });
  });

  it("clears project_type when value is 'none'", async () => {
    const { setProjectType } = await import("../app/pm/projects/actions");
    const fd = new FormData();
    fd.set("project_type", "none");
    await setProjectType(PROJECT_ID, fd);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.set).toMatchObject({ projectType: null });
  });
});
