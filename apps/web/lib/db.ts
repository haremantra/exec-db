import { getDb, withSession, type Db, type SessionContext } from "@exec-db/db";

let _db: Db | null = null;

function db(): Db {
  if (_db) return _db;
  const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_APP (or DATABASE_URL) is required");
  _db = getDb(url);
  return _db;
}

export async function query<T>(ctx: SessionContext, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withSession(db(), ctx, fn);
}
