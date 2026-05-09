#!/usr/bin/env tsx
/**
 * exec-db bootstrap CLI
 *
 * Automates the mechanical parts of the PR2 + PR3 prereqs runbooks:
 *   - Secret generation (EMAIL_INTAKE_SECRET, GOOGLE_TOKEN_ENC_KEY, CRON_SECRET)
 *   - Shape-validation of pasted credentials (Google, Resend)
 *   - DNS SPF/DKIM confirmation (dig TXT)
 *   - Postgres connectivity + pgcrypto/uuid-ossp extension check
 *   - Schema push + RLS apply + optional seed
 *   - Final go/no-go status table
 *
 * Does NOT replace browser steps (GCP console, OAuth consent screen,
 * DNS record paste, Vercel project setup).
 *
 * Run: pnpm bootstrap [flags]
 * Flags: --force  --seed  --non-interactive  --check-only  --help
 *
 * Env writes: assembled in memory, written once to .env at the end of the
 * interactive phase (before DB steps). Re-running is safe — existing values
 * are preserved unless --force is passed.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only reference so tsc doesn't need to resolve the postgres module.
// At runtime tsx resolves it from the workspace node_modules.
type Sql = {
  <T = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe(query: string): Promise<unknown>;
  end(): Promise<void>;
};
type PostgresFn = (url: string, opts: Record<string, unknown>) => Sql;

/** Dynamically load the postgres package (avoids tsc module-resolution errors). */
async function getPostgres(): Promise<PostgresFn> {
  // Use a variable so tsc skips static module-resolution analysis.
  const specifier = "postgres";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await (import(specifier) as Promise<any>);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
  return (mod.default ?? mod) as PostgresFn;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
const ENV_EXAMPLE_PATH = resolve(REPO_ROOT, ".env.example");

// ANSI colours (used only when stdout is a TTY)
const isTTY = process.stdout.isTTY ?? false;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  dim: isTTY ? "\x1b[2m" : "",
};

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAGS = {
  force: args.includes("--force"),
  seed: args.includes("--seed"),
  nonInteractive: args.includes("--non-interactive"),
  checkOnly: args.includes("--check-only"),
  help: args.includes("--help") || args.includes("-h"),
};

if (FLAGS.help) {
  console.log(`
${c.bold}exec-db bootstrap CLI${c.reset}

Usage: pnpm bootstrap [flags]

Flags:
  --force            Re-prompt for all vars even if already in .env
  --seed             Run db:seed after schema push (off by default)
  --non-interactive  Fail rather than prompt; useful for CI dry-runs
  --check-only       Validate state without writing or running anything
  -h, --help         Show this help

What it automates:
  - Secret generation (EMAIL_INTAKE_SECRET, GOOGLE_TOKEN_ENC_KEY, CRON_SECRET)
  - Credential shape validation (Google OAuth, Resend API key)
  - DNS SPF/DKIM check (dig TXT)
  - Postgres connectivity + pgcrypto/uuid-ossp extension check + install
  - Schema push (db:push), RLS apply (db:rls), optional seed (db:seed)
  - Final go/no-go status table

What it does NOT replace:
  - GCP console clicks (project, APIs, OAuth consent screen)
  - DNS record paste at your registrar
  - Vercel project setup and env var configuration
  See docs/pr2-prereqs-runbook.md and docs/pr3-prereqs-runbook.md.
`);
  process.exit(0);
}

// ─── Pure-function validators (exported for tests) ───────────────────────────

/** Validate Google OAuth Client ID shape: must end with .apps.googleusercontent.com */
export function validateGoogleClientId(value: string): boolean {
  return /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(value.trim());
}

/** Validate Google OAuth Client Secret shape: must start with GOCSPX- */
export function validateGoogleClientSecret(value: string): boolean {
  return /^GOCSPX-/.test(value.trim());
}

/** Validate Resend API key shape: must start with re_ */
export function validateResendApiKey(value: string): boolean {
  return /^re_/.test(value.trim());
}

/** Parse a postgres:// or postgresql:// URL; returns true if valid */
export function parsePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

/** Extract bare domain from an email address or URL */
export function extractDomain(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    return trimmed.split("@")[1] ?? trimmed;
  }
  try {
    return new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

/** Validate EMAIL_INTAKE_SECRET: must be 64 hex chars (32 bytes hex-encoded) */
export function validateIntakeSecret(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value.trim());
}

/** Validate GOOGLE_TOKEN_ENC_KEY: must be a valid base64 string of ~44 chars */
export function validateTokenEncKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=?$/.test(value.trim());
}

/** Validate OAuth scopes string includes required scopes and not gmail.send */
export function validateGoogleScopes(scopeString: string): boolean {
  const required = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ];
  const forbidden = "https://mail.google.com/";
  const scopeList = scopeString.split(" ");
  const hasRequired = required.every((s) => scopeList.includes(s));
  const hasForbidden =
    scopeList.includes("https://www.googleapis.com/auth/gmail.send") ||
    scopeList.includes(forbidden);
  return hasRequired && !hasForbidden;
}

// ─── Env file helpers ─────────────────────────────────────────────────────────

type EnvMap = Record<string, string>;

function parseEnvFile(filePath: string): EnvMap {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, "utf8").split("\n");
  const result: EnvMap = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    result[key] = val;
  }
  return result;
}

function serializeEnv(map: EnvMap, originalLines: string[]): string {
  // Preserve comments and structure from original; update/append changed values.
  const written = new Set<string>();
  const output: string[] = [];

  for (const raw of originalLines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      output.push(raw);
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      output.push(raw);
      continue;
    }
    const key = line.slice(0, idx).trim();
    if (key in map) {
      output.push(`${key}=${map[key]}`);
      written.add(key);
    } else {
      output.push(raw);
    }
  }

  // Append new keys not in the original file
  const newKeys = Object.keys(map).filter((k) => !written.has(k));
  if (newKeys.length > 0) {
    output.push("");
    output.push("# Added by bootstrap CLI");
    for (const k of newKeys) {
      output.push(`${k}=${map[k]}`);
    }
  }

  return output.join("\n") + "\n";
}

// ─── Step runner ──────────────────────────────────────────────────────────────

let stepIndex = 0;
const totalSteps = 21;

function stepHeader(name: string): void {
  stepIndex++;
  console.log(
    `\n${c.bold}Step ${stepIndex}/${totalSteps} — ${name}${c.reset}`,
  );
}

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`);
}

function fail(msg: string, hint?: string): never {
  console.error(`\n${c.red}✗ FAIL${c.reset} ${msg}`);
  if (hint) console.error(`  ${c.dim}${hint}${c.reset}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`  ${c.cyan}→${c.reset} ${msg}`);
}

// ─── Interactive prompt helpers ───────────────────────────────────────────────

let rl: ReturnType<typeof createInterface> | null = null;

function getReadline(): ReturnType<typeof createInterface> {
  if (!rl) {
    rl = createInterface({ input, output, terminal: false });
  }
  return rl;
}

async function prompt(
  question: string,
  defaultVal?: string,
  secret = false,
): Promise<string> {
  if (FLAGS.nonInteractive) {
    if (defaultVal !== undefined) return defaultVal;
    fail(
      `--non-interactive: cannot prompt for "${question}"`,
      "Provide all required vars in .env before running with --non-interactive.",
    );
  }
  const suffix =
    defaultVal !== undefined ? ` ${c.dim}[${defaultVal}]${c.reset}` : "";
  const raw = await getReadline().question(`  ${c.cyan}→${c.reset} ${question}${suffix}: `);
  const trimmed = raw.trim();
  if (!trimmed && defaultVal !== undefined) return defaultVal;
  if (!trimmed) {
    // Empty with no default — ask again
    return prompt(question, defaultVal, secret);
  }
  if (!secret) {
    // Value already echoed by readline
  }
  return trimmed;
}

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (FLAGS.nonInteractive) return defaultYes;
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const raw = await getReadline().question(
    `  ${c.cyan}→${c.reset} ${question} ${c.dim}${hint}${c.reset}: `,
  );
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

// ─── Shell helpers ────────────────────────────────────────────────────────────

function shellOut(
  cmd: string,
  args: string[],
  { cwd = REPO_ROOT, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function streamShellOut(cmd: string, args: string[]): boolean {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    encoding: "utf8",
  });
  return result.status === 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
${c.bold}exec-db bootstrap${c.reset}
─────────────────
Automates the mechanical parts of the PR2 + PR3 prereqs runbooks.
Run ${c.dim}pnpm bootstrap --help${c.reset} for full usage.
`);

  if (FLAGS.checkOnly) {
    info("--check-only: validating state without writing or running anything.");
  }

  // ── Step 1: Detect existing .env ────────────────────────────────────────────
  stepHeader("Detect existing .env");

  if (!existsSync(ENV_PATH)) {
    if (FLAGS.checkOnly) {
      warn(".env does not exist (would copy from .env.example)");
    } else {
      if (!existsSync(ENV_EXAMPLE_PATH)) {
        fail("Neither .env nor .env.example found in repo root.");
      }
      copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      ok("Copied .env.example → .env");
    }
  } else {
    ok(".env found");
    if (FLAGS.force) {
      info("--force: all vars will be re-prompted regardless of existing values.");
    }
  }

  // Load current state
  let env: EnvMap = parseEnvFile(ENV_PATH);
  const originalLines = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, "utf8").split("\n")
    : [];

  // Helper: get value (existing or prompt)
  const needs = (key: string): boolean =>
    FLAGS.force || !env[key] || env[key] === "";

  async function getOrPrompt(
    key: string,
    question: string,
    opts: {
      defaultVal?: string;
      secret?: boolean;
      generate?: () => string;
    } = {},
  ): Promise<string> {
    if (!needs(key)) {
      ok(`${key} already set — skipping`);
      return env[key]!;
    }
    if (opts.generate && !FLAGS.checkOnly) {
      const generated = opts.generate();
      ok(`Generated ${key}`);
      env[key] = generated;
      return generated;
    }
    if (FLAGS.checkOnly) {
      warn(`${key} is missing or empty`);
      return env[key] ?? "";
    }
    const val = await prompt(question, opts.defaultVal, opts.secret);
    env[key] = val;
    return val;
  }

  // ── Step 2: Generate EMAIL_INTAKE_SECRET ─────────────────────────────────────
  stepHeader("Generate EMAIL_INTAKE_SECRET");
  info("(see docs/pr3-prereqs-runbook.md Category 2)");
  await getOrPrompt("EMAIL_INTAKE_SECRET", "EMAIL_INTAKE_SECRET (paste or press Enter to generate)", {
    generate: () => randomBytes(32).toString("hex"),
  });

  // ── Step 3: Generate GOOGLE_TOKEN_ENC_KEY ────────────────────────────────────
  stepHeader("Generate GOOGLE_TOKEN_ENC_KEY");
  info("(see docs/pr3-prereqs-runbook.md Category 3)");
  info("BLOCKER #AUDIT-1: absent key causes pgp_sym_encrypt to fail at runtime");
  await getOrPrompt("GOOGLE_TOKEN_ENC_KEY", "GOOGLE_TOKEN_ENC_KEY (paste or press Enter to generate)", {
    generate: () => randomBytes(32).toString("base64"),
  });

  // Validate shape
  const encKey = env["GOOGLE_TOKEN_ENC_KEY"] ?? "";
  if (encKey && !validateTokenEncKey(encKey)) {
    warn(
      "GOOGLE_TOKEN_ENC_KEY does not look like a base64-32-byte value. " +
        "Expected ~44 chars ending in '='. Continuing, but verify the value.",
    );
  }

  // ── Step 4: ANTHROPIC_API_KEY ────────────────────────────────────────────────
  stepHeader("ANTHROPIC_API_KEY");
  info("(obtain from https://console.anthropic.com/)");
  const anthropicKey = await getOrPrompt(
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY",
    { secret: true },
  );

  if (anthropicKey && !FLAGS.checkOnly) {
    const doTest = await confirm(
      "Test ANTHROPIC_API_KEY with a 1-token call?",
      false,
    );
    if (doTest) {
      try {
        // Dynamic import to avoid hard dep at module load time
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: anthropicKey });
        await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "Hi" }],
        });
        ok("ANTHROPIC_API_KEY is valid");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Anthropic connectivity test failed: ${msg}`);
        info("Continuing — fix ANTHROPIC_API_KEY before running the app.");
      }
    }
  }

  // ── Step 5: Google OAuth credentials ────────────────────────────────────────
  stepHeader("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  info("(see docs/pr2-prereqs-runbook.md step 20)");

  const clientId = await getOrPrompt(
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_ID (must end with .apps.googleusercontent.com)",
    { secret: false },
  );
  if (clientId && !validateGoogleClientId(clientId)) {
    warn(
      "GOOGLE_CLIENT_ID does not match expected shape *.apps.googleusercontent.com",
    );
  }

  const clientSecret = await getOrPrompt(
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET (must start with GOCSPX-)",
    { secret: true },
  );
  if (clientSecret && !validateGoogleClientSecret(clientSecret)) {
    warn("GOOGLE_CLIENT_SECRET does not match expected shape GOCSPX-…");
  }

  // ── Step 6: GOOGLE_OAUTH_REDIRECT_URI ───────────────────────────────────────
  stepHeader("GOOGLE_OAUTH_REDIRECT_URI");
  info("(see docs/pr2-prereqs-runbook.md step 19)");
  await getOrPrompt("GOOGLE_OAUTH_REDIRECT_URI", "GOOGLE_OAUTH_REDIRECT_URI", {
    defaultVal: "http://localhost:3000/api/auth/google/callback",
  });

  // ── Step 7: RESEND_API_KEY ───────────────────────────────────────────────────
  stepHeader("RESEND_API_KEY");
  info("(see docs/pr3-prereqs-runbook.md Category 1)");
  const resendKey = await getOrPrompt("RESEND_API_KEY", "RESEND_API_KEY (must start with re_)", {
    secret: true,
  });
  if (resendKey && !validateResendApiKey(resendKey)) {
    warn("RESEND_API_KEY does not match expected shape re_…");
  }

  if (resendKey && validateResendApiKey(resendKey) && !FLAGS.checkOnly) {
    const doResendTest = await confirm(
      "Send a test email via Resend to verify the key?",
      false,
    );
    if (doResendTest) {
      const recipient = await prompt("Recipient email address for test");
      const fromAddr = env["RESEND_FROM_ADDRESS"] ?? "";
      try {
        const resendSpecifier = "resend";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resendMod = await (import(resendSpecifier) as Promise<any>);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const client = new (resendMod.Resend ?? resendMod.default?.Resend)(resendKey);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const { error } = await client.emails.send({
          from: fromAddr || "onboarding@resend.dev",
          to: recipient,
          subject: "exec-db bootstrap test",
          html: "<p>Bootstrap connectivity test — you can delete this email.</p>",
          text: "Bootstrap connectivity test — you can delete this email.",
        }) as { error: { message: string } | null };
        if (error) {
          fail(
            `Resend test failed: ${error.message}`,
            "Check RESEND_API_KEY and that the from address is on a verified domain.",
          );
        }
        ok(`Test email sent to ${recipient}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Resend connectivity test error: ${msg}`);
      }
    }
  }

  // ── Step 8: RESEND_FROM_ADDRESS ──────────────────────────────────────────────
  stepHeader("RESEND_FROM_ADDRESS");
  info("(must be on a Resend-verified sender domain)");
  await getOrPrompt("RESEND_FROM_ADDRESS", "RESEND_FROM_ADDRESS (e.g. digests@mail.yourcompany.com)");

  // ── Step 9: RESEND_FROM_DOMAIN + DNS check ───────────────────────────────────
  stepHeader("RESEND_FROM_DOMAIN and DNS verification");
  info("(see docs/pr3-prereqs-runbook.md Category 1, step 2)");

  const fromAddr = env["RESEND_FROM_ADDRESS"] ?? "";
  const domainDefault = fromAddr ? extractDomain(fromAddr) : "";
  const fromDomain = await getOrPrompt(
    "RESEND_FROM_DOMAIN",
    "RESEND_FROM_DOMAIN (bare domain, e.g. mail.yourcompany.com)",
    domainDefault ? { defaultVal: domainDefault } : {},
  );

  if (fromDomain && !FLAGS.checkOnly) {
    info(`Running DNS check: dig TXT ${fromDomain}`);
    const digResult = shellOut("dig", ["TXT", fromDomain, "+short"]);
    if (!digResult.ok || !digResult.stdout.trim()) {
      warn(`No TXT records found for ${fromDomain}. DNS may not have propagated yet.`);
      info("Re-run bootstrap after DNS propagates (typically 5–15 min).");
    } else {
      const txt = digResult.stdout;
      const hasSpf = txt.toLowerCase().includes("v=spf1");
      const hasDkim = txt.includes("DKIM") || txt.includes("dkim") || txt.toLowerCase().includes("k=rsa") || txt.toLowerCase().includes("p=");
      if (hasSpf) ok("SPF record found");
      else warn("SPF record not found in TXT records yet — DNS may still be propagating.");
      if (hasDkim) ok("DKIM-like record found");
      else {
        // DKIM often lives on a subdomain (resend._domainkey.domain)
        const dkimDomain = `resend._domainkey.${fromDomain}`;
        info(`Checking DKIM subdomain: dig TXT ${dkimDomain}`);
        const dkimResult = shellOut("dig", ["TXT", dkimDomain, "+short"]);
        if (dkimResult.stdout.trim()) {
          ok("DKIM record found on resend._domainkey subdomain");
        } else {
          warn("DKIM record not confirmed — DNS may still be propagating.");
        }
      }
    }
  } else if (fromDomain && FLAGS.checkOnly) {
    info(`(DNS check skipped in --check-only mode for ${fromDomain})`);
  }

  // ── Step 10: GOOGLE_SHEETS_AUDIT_ID ─────────────────────────────────────────
  stepHeader("GOOGLE_SHEETS_AUDIT_ID");
  info("(see docs/pr2-prereqs-runbook.md step 31)");
  await getOrPrompt("GOOGLE_SHEETS_AUDIT_ID", "GOOGLE_SHEETS_AUDIT_ID (the long spreadsheet ID from the URL)");

  // ── Step 11: GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH ─────────────────────────
  stepHeader("GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH");
  info("(see docs/pr2-prereqs-runbook.md step 26 — use absolute path, no ~)");

  const saKeyPath = await getOrPrompt(
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH (absolute path to audit-writer.json)",
  );

  if (saKeyPath && !FLAGS.checkOnly) {
    if (!existsSync(saKeyPath)) {
      warn(
        `File not found: ${saKeyPath}. Ensure the service-account JSON is at this path.`,
      );
    } else {
      try {
        const rawJson = readFileSync(saKeyPath, "utf8");
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        if (!parsed["client_email"] || !parsed["private_key"]) {
          fail(
            "Service-account JSON is missing client_email or private_key fields.",
            "Re-download the JSON key from GCP Credentials (see pr2-prereqs-runbook.md step 26).",
          );
        }
        ok("Service-account JSON is valid and has required fields");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Failed to parse service-account JSON: ${msg}`);
      }
    }
  }

  // ── Step 12: COMPETITOR_DOMAINS ──────────────────────────────────────────────
  stepHeader("COMPETITOR_DOMAINS");
  info("(see docs/pr3-prereqs-runbook.md Category 4)");
  info("Comma-separated list of competitor domains. Empty is acceptable.");
  await getOrPrompt("COMPETITOR_DOMAINS", "COMPETITOR_DOMAINS (comma-separated, or press Enter to skip)", {
    defaultVal: "",
  });

  // ── Step 13: NEXT_PUBLIC_APP_URL ─────────────────────────────────────────────
  stepHeader("NEXT_PUBLIC_APP_URL");
  await getOrPrompt("NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_APP_URL", {
    defaultVal: "http://localhost:3000",
  });

  // ── Step 14: CRON_SECRET ────────────────────────────────────────────────────
  stepHeader("CRON_SECRET");
  info("Vercel auto-sets CRON_SECRET in production. For local dev, any string works.");
  await getOrPrompt("CRON_SECRET", "CRON_SECRET (press Enter to auto-generate for local dev)", {
    generate: () => randomBytes(32).toString("hex"),
  });

  // ── Step 15: DATABASE_URL ────────────────────────────────────────────────────
  stepHeader("DATABASE_URL");
  info("(see docs/deploy-checklist.md Section 3)");
  info("Used for migrations and schema pushes (requires superuser or equivalent).");

  const dbUrl = await getOrPrompt(
    "DATABASE_URL",
    "DATABASE_URL (postgres://user:pass@host:5432/dbname)",
    { defaultVal: "postgres://postgres:postgres@localhost:5432/exec_db" },
  );

  if (dbUrl && !parsePostgresUrl(dbUrl)) {
    fail(
      "DATABASE_URL does not look like a valid postgres:// URL.",
      "Expected format: postgres://user:password@host:5432/database",
    );
  }

  if (dbUrl && !FLAGS.checkOnly) {
    info("Testing DATABASE_URL connectivity (SELECT 1)...");
    try {
      const postgres = await getPostgres();
      const sql = postgres(dbUrl, { max: 1, connect_timeout: 10 });
      try {
        await sql`SELECT 1`;
        ok("DATABASE_URL connection successful");
      } finally {
        await sql.end();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Cannot connect to DATABASE_URL: ${msg}`, "Check the URL and that Postgres is running.");
    }
  }

  // ── Step 16: DATABASE_URL_APP ────────────────────────────────────────────────
  stepHeader("DATABASE_URL_APP");
  info("Least-privileged role for runtime reads. Can be the same as DATABASE_URL in local dev.");

  const sameAsMain = await confirm("Use same DATABASE_URL for DATABASE_URL_APP (local dev)?", true);
  if (sameAsMain) {
    if (!needs("DATABASE_URL_APP")) {
      ok("DATABASE_URL_APP already set — skipping");
    } else {
      env["DATABASE_URL_APP"] = dbUrl;
      ok("Set DATABASE_URL_APP = DATABASE_URL");
    }
  } else {
    const dbUrlApp = await getOrPrompt(
      "DATABASE_URL_APP",
      "DATABASE_URL_APP (postgres://app_runtime:pass@host:5432/dbname)",
    );
    if (dbUrlApp && !parsePostgresUrl(dbUrlApp)) {
      fail("DATABASE_URL_APP does not look like a valid postgres:// URL.");
    }
    if (dbUrlApp && !FLAGS.checkOnly) {
      info("Testing DATABASE_URL_APP connectivity...");
      try {
        const postgres = await getPostgres();
        const sql = postgres(dbUrlApp, { max: 1, connect_timeout: 10 });
        try {
          await sql`SELECT 1`;
          ok("DATABASE_URL_APP connection successful");
        } finally {
          await sql.end();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Cannot connect to DATABASE_URL_APP: ${msg}`);
      }
    }
  }

  // ── Step 17: Verify Postgres extensions ─────────────────────────────────────
  stepHeader("Verify Postgres extensions (pgcrypto, uuid-ossp)");
  info(
    "BLOCKER #AUDIT-2/#AUDIT-3: pgcrypto required for GOOGLE_TOKEN_ENC_KEY; uuid-ossp for ID generation.",
  );

  if (dbUrl && !FLAGS.checkOnly) {
    try {
      const postgres = await getPostgres();
      const sql = postgres(dbUrl, { max: 1, connect_timeout: 10 });
      try {
        const rows = (await sql`
          SELECT extname FROM pg_extension
          WHERE extname IN ('pgcrypto', 'uuid-ossp')
        `) as Array<{ extname: string }>;
        const found = new Set(rows.map((r: { extname: string }) => r.extname));
        const missing = ["pgcrypto", "uuid-ossp"].filter((e) => !found.has(e));

        for (const ext of ["pgcrypto", "uuid-ossp"]) {
          if (found.has(ext)) ok(`${ext} extension is installed`);
        }

        if (missing.length > 0) {
          warn(`Missing extensions: ${missing.join(", ")}. Attempting to create...`);
          for (const ext of missing) {
            try {
              await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
              ok(`Created extension: ${ext}`);
            } catch (createErr: unknown) {
              const msg = createErr instanceof Error ? createErr.message : String(createErr);
              fail(
                `Cannot create extension ${ext}: ${msg}`,
                `BLOCKER: Run as a superuser: CREATE EXTENSION IF NOT EXISTS "${ext}"; ` +
                  "See docs/runbook-audit.md BLOCKER findings for context.",
              );
            }
          }
        }
      } finally {
        await sql.end();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Extension check skipped (DB connection error): ${msg}`);
    }
  } else if (FLAGS.checkOnly) {
    info("(extension check skipped in --check-only mode)");
  }

  // ── Write .env ───────────────────────────────────────────────────────────────
  if (!FLAGS.checkOnly) {
    const serialized = serializeEnv(env, originalLines);
    writeFileSync(ENV_PATH, serialized, "utf8");
    ok(".env written successfully");
  } else {
    ok("(--check-only: .env not written)");
  }

  // ── Step 18: db:push ────────────────────────────────────────────────────────
  stepHeader("Run db:push (apply schema)");
  if (FLAGS.checkOnly) {
    info("(skipped in --check-only mode)");
  } else {
    info("Running: pnpm --filter @exec-db/db db:push");
    const ok18 = streamShellOut("pnpm", ["--filter", "@exec-db/db", "db:push"]);
    if (!ok18) {
      fail("db:push failed. Fix schema errors before continuing.");
    }
    ok("db:push complete");
  }

  // ── Step 19: db:rls ─────────────────────────────────────────────────────────
  stepHeader("Run db:rls (apply RLS policies)");
  if (FLAGS.checkOnly) {
    info("(skipped in --check-only mode)");
  } else {
    info("Running: pnpm --filter @exec-db/db db:rls");
    const ok19 = streamShellOut("pnpm", ["--filter", "@exec-db/db", "db:rls"]);
    if (!ok19) {
      fail("db:rls failed. Check Postgres superuser privileges.");
    }
    ok("db:rls complete");
  }

  // ── Step 20: db:seed (optional) ─────────────────────────────────────────────
  stepHeader("db:seed (optional)");
  if (!FLAGS.seed) {
    info("Skipped (pass --seed to run). Default off to avoid prod data pollution.");
  } else if (FLAGS.checkOnly) {
    info("(skipped in --check-only mode)");
  } else {
    info("Running: pnpm --filter @exec-db/db db:seed");
    const ok20 = streamShellOut("pnpm", ["--filter", "@exec-db/db", "db:seed"]);
    if (!ok20) {
      warn("db:seed exited with non-zero status. Review output above.");
    } else {
      ok("db:seed complete");
    }
  }

  // ── Step 21: Final status table ──────────────────────────────────────────────
  stepHeader("Final go/no-go status");

  // Re-read env (may have been updated above)
  env = parseEnvFile(ENV_PATH);

  const checks: Array<{ phase: string; vars: string[]; label: string }> = [
    {
      phase: "Phase 0 — Accounts",
      label: "GitHub, Anthropic, Resend, Google Workspace",
      vars: ["ANTHROPIC_API_KEY"],
    },
    {
      phase: "Phase 1 — GCP + OAuth",
      label: "pr2-prereqs-runbook.md cats 1–5",
      vars: [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_OAUTH_REDIRECT_URI",
        "GOOGLE_TOKEN_ENC_KEY",
      ],
    },
    {
      phase: "Phase 2 — Audit Sheet",
      label: "pr2-prereqs-runbook.md cat 6",
      vars: [
        "GOOGLE_SHEETS_AUDIT_ID",
        "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH",
      ],
    },
    {
      phase: "Phase 3 — PR3 env vars",
      label: "pr3-prereqs-runbook.md cats 1–5",
      vars: [
        "RESEND_API_KEY",
        "RESEND_FROM_ADDRESS",
        "EMAIL_INTAKE_SECRET",
        "NEXT_PUBLIC_APP_URL",
        "CRON_SECRET",
      ],
    },
    {
      phase: "Phase 4 — Database",
      label: "DATABASE_URL + DATABASE_URL_APP",
      vars: ["DATABASE_URL", "DATABASE_URL_APP"],
    },
    {
      phase: "Phase 5 — Vercel deploy",
      label: "pr3-prereqs-runbook.md cat 6 (manual)",
      vars: [],
    },
  ];

  const lineWidth = 58;
  const border = "─".repeat(lineWidth);

  console.log(`\n╭${border}╮`);
  console.log(
    `│ ${c.bold}exec-db bootstrap — final status${c.reset}`.padEnd(lineWidth + (isTTY ? 8 : 0)) + " │",
  );
  console.log(`├${border}┤`);

  let allGreen = true;
  for (const check of checks) {
    const missing = check.vars.filter((v) => !env[v] || env[v] === "");
    const done = check.vars.length === 0 || missing.length === 0;
    if (!done) allGreen = false;

    const status = done
      ? `${c.green}☑ done${c.reset}`
      : `${c.yellow}☐ missing: ${missing.join(", ")}${c.reset}`;

    const phaseLabel = check.phase.padEnd(28);
    const line = `│ ${phaseLabel} ${status}`;
    const visibleLength = 2 + 28 + 1 + (done ? 6 : 9 + missing.join(", ").length);
    const paddingNeeded = lineWidth + 2 - (done ? 8 : 11 + missing.join(", ").length) + (isTTY ? (done ? 9 : 9) : 0);
    // Simple approach: use console.log directly
    console.log(line);
  }

  console.log(`╰${border}╯`);

  if (allGreen) {
    console.log(`\n${c.green}${c.bold}All required env vars are set. Ready to develop!${c.reset}`);
    console.log(
      `${c.dim}Next: pnpm dev   |   For production, complete Vercel setup per docs/pr3-prereqs-runbook.md cat 6.${c.reset}`,
    );
  } else {
    console.log(
      `\n${c.yellow}Some env vars are missing. See items marked above.${c.reset}`,
    );
    console.log(
      `${c.dim}Re-run pnpm bootstrap to fill in missing values, or edit .env directly.${c.reset}`,
    );
  }

  if (rl) rl.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (rl) rl.close();
  process.exit(1);
});
