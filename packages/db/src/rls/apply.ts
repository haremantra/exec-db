import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES = ["roles.sql", "policies.sql", "audit-triggers.sql"] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app;`);

    for (const file of FILES) {
      const path = join(__dirname, file);
      const body = await readFile(path, "utf8");
      console.log(`>> applying ${file}`);
      await sql.unsafe(body);
    }
    console.log("RLS layer applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
