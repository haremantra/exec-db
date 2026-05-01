import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export type SessionContext = {
  userId: string;
  tier: "exec_all" | "function_lead" | "manager" | "employee";
  functionArea: string | null;
};

let _pool: ReturnType<typeof postgres> | null = null;

export function getPool(connectionString: string): ReturnType<typeof postgres> {
  if (_pool) return _pool;
  _pool = postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    prepare: false,
  });
  return _pool;
}

export function getDb(connectionString: string): Db {
  return drizzle(getPool(connectionString), { schema });
}

/**
 * Run a query with the per-request RLS context applied via Postgres GUCs.
 * Policies in `comp.*` and `hr.*` read these via `current_setting('app.user_id')` etc.
 */
export async function withSession<T>(
  db: Db,
  ctx: SessionContext,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      `SELECT
        set_config('app.user_id', '${ctx.userId.replace(/'/g, "''")}', true),
        set_config('app.tier', '${ctx.tier}', true),
        set_config('app.function_area', '${(ctx.functionArea ?? "").replace(/'/g, "''")}', true)`,
    );
    return fn(tx as Db);
  });
}
