import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required for drizzle-kit");
}

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  schemaFilter: ["core", "hr", "comp", "fin", "legal", "ops", "crm", "pm", "audit"],
  strict: true,
  verbose: true,
} satisfies Config;
