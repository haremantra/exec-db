// Google Sheets appender for the LLM audit log (SY-017, E2).
//
// Required env vars (set by admin per PR2 prereqs P4):
//   GOOGLE_SHEETS_AUDIT_ID              — the spreadsheet ID from the sheet URL
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH — path to the service account JSON key file
//
// The Postgres audit.llm_call table is the source of truth. This Sheet is a
// secondary, human-readable tier for analytics and Gemini-readable exports.
// On failure, we log to console.error and continue — we do NOT throw.
//
// Implementation note: this module imports `googleapis` dynamically so that
// the app starts without error even if the package is not yet installed
// (e.g., in test environments). The dependency must be added to packageon
// and `pnpm install` run before production use.
//
// To activate:
//   1. `pnpm --filter @exec-db/web add googleapis`
//   2. Set GOOGLE_SHEETS_AUDIT_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH
//      in your .env (see docs/pr2-prereqs-runbook.md section P4).
//   3. Share the sheet with write access to the service account email.

import { readFileSync } from "node:fs";

export type AuditLlmCallRow = {
  timestampUtc: string;
  contactId: string;
  model: string;
  promptClass: string;
  redactedInputHash: string;
  responseHash: string;
  redactionsApplied: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  outcome: string;
};

const SHEET_COLUMNS: string[] = [
  "timestamp_utc",
  "contact_id",
  "model",
  "prompt_class",
  "redacted_input_hash",
  "response_hash",
  "redactions_applied",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "outcome",
];

function rowToValues(row: AuditLlmCallRow): (string | number)[] {
  return [
    row.timestampUtc,
    row.contactId,
    row.model,
    row.promptClass,
    row.redactedInputHash,
    row.responseHash,
    row.redactionsApplied,
    row.inputTokens,
    row.outputTokens,
    row.costUsd,
    row.outcome,
  ];
}

/**
 * Append one LLM call row to the configured Google Sheet.
 *
 * Never throws — on any error (missing env, auth failure, quota, network)
 * we log to console.error and return. The Postgres write is already durable.
 */
export async function appendLlmCallToSheet(row: AuditLlmCallRow): Promise<void> {
  const sheetId = process.env["GOOGLE_SHEETS_AUDIT_ID"];
  const keyPath = process.env["GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH"];

  if (!sheetId || !keyPath) {
    // Not configured — silently skip. This is expected in dev / CI.
    return;
  }

  let googleapis: typeof import("googleapis");
  try {
    // Dynamic import so tests and dev environments without the package don't fail.
    googleapis = await import("googleapis");
  } catch {
    console.error(
      "[audit-sheet] `googleapis` package is not installed. " +
        "Run `pnpm --filter @exec-db/web add googleapis` to activate Sheet appending.",
    );
    return;
  }

  try {
    const keyJson = JSON.parse(readFileSync(keyPath, "utf-8")) as {
      client_email: string;
      private_key: string;
    };

    const auth = new googleapis.google.auth.GoogleAuth({
      credentials: {
        client_email: keyJson.client_email,
        private_key: keyJson.private_key,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = googleapis.google.sheets({ version: "v4", auth });

    // Ensure header row exists on first append (idempotent — only writes if A1 is empty).
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "A1:K1",
    });
    if (!headerCheck.data.values || headerCheck.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: "A1:K1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_COLUMNS] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "A:K",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowToValues(row)] },
    });
  } catch (err: unknown) {
    console.error("[audit-sheet] Failed to append row to Google Sheet (non-fatal):", err);
  }
}
