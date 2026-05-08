/**
 * draft-guard.ts — Confidential-content guard for Gmail draft saves.
 *
 * PURPOSE (AD-003 / W4.6):
 * ────────────────────────────────────────────────────────────────────────────
 * Before any draft body is saved to Gmail, `assertSafeForGmail` scans it for
 * known confidential markers.  If any are found, the function returns
 * `{ safe: false, reasons: [...] }` so the calling server action can block
 * the save and surface the list of reasons to the UI.
 *
 * The exec must explicitly confirm ("I confirm this is safe") before the save
 * is retried via `saveDraftToGmailConfirmed`.  That override path logs an
 * audit row (see actions.ts).
 *
 * INVARIANT (AD-004):
 * This file NEVER imports gmail.users.messages.send.  The only Gmail write
 * surface in this codebase is `createGmailDraft` in google-gmail.ts.
 *
 * CATEGORIES DETECTED:
 * ─────────────────────
 * 1. banking       — account numbers, routing numbers, IBAN, wire-transfer
 * 2. deal-terms    — acquisition, LOI, term sheet, valuation
 * 3. comp          — salary, equity, RSU, bonus, compensation
 * 4. internal-only — #internal marker, [CONFIDENTIAL] tag
 *
 * All matches are case-insensitive.
 */

// ── Marker definitions ────────────────────────────────────────────────────────

type MarkerCategory =
  | "banking"
  | "deal-terms"
  | "comp"
  | "internal-only";

interface Marker {
  category: MarkerCategory;
  /** Human-readable label surfaced in the UI warning. */
  label: string;
  /** Regex to detect the marker.  All patterns are case-insensitive (/i). */
  pattern: RegExp;
}

const MARKERS: Marker[] = [
  // ── Banking ────────────────────────────────────────────────────────────────
  {
    category: "banking",
    label: "banking / financial account reference",
    pattern:
      /\b(account\s+number|routing\s+number|IBAN|wire\s+transfer|bank\s+account|ABA\s+routing|swift\s+code|ACH\s+transfer)\b/i,
  },

  // ── Deal terms ─────────────────────────────────────────────────────────────
  {
    category: "deal-terms",
    label: "acquisition / M&A reference",
    pattern: /\bacquisition\b/i,
  },
  {
    category: "deal-terms",
    label: "LOI (letter of intent) reference",
    pattern: /\bLOI\b|\bletter\s+of\s+intent\b/i,
  },
  {
    category: "deal-terms",
    label: "term sheet reference",
    pattern: /\bterm\s+sheet\b/i,
  },
  {
    category: "deal-terms",
    label: "valuation / cap-table reference",
    pattern: /\bvaluation\b|\bcap\s+table\b|\bpre-money\b|\bpost-money\b/i,
  },

  // ── Comp ───────────────────────────────────────────────────────────────────
  {
    category: "comp",
    label: "salary / compensation reference",
    pattern: /\bsalary\b|\bbase\s+pay\b|\bcompensation\b/i,
  },
  {
    category: "comp",
    label: "equity / RSU reference",
    pattern: /\bequity\b|\bRSU\b|\bstock\s+option\b|\bvesting\b/i,
  },

  // ── Internal-only markers ──────────────────────────────────────────────────
  {
    category: "internal-only",
    label: "#internal marker present",
    pattern: /#internal\b/i,
  },
  {
    category: "internal-only",
    label: "[CONFIDENTIAL] tag present",
    pattern: /\[CONFIDENTIAL\]/i,
  },
];

// ── Public type ───────────────────────────────────────────────────────────────

export interface GuardResult {
  /** true when no confidential markers are found. */
  safe: boolean;
  /**
   * Human-readable reasons explaining why the body was flagged.
   * Empty when `safe === true`.
   */
  reasons: string[];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scan `body` for confidential markers and return a safety verdict.
 *
 * @param body  The draft body (markdown or plain text) to scan.
 * @returns     `{ safe: true, reasons: [] }` if clean;
 *              `{ safe: false, reasons: ["…", …] }` if any markers fire.
 *
 * @example
 * ```ts
 * const result = assertSafeForGmail(draft.bodyMarkdown ?? "");
 * if (!result.safe) {
 *   throw new Error("Confidential content: " + result.reasons.join("; "));
 * }
 * ```
 */
export function assertSafeForGmail(body: string): GuardResult {
  const reasons: string[] = [];

  for (const marker of MARKERS) {
    if (marker.pattern.test(body)) {
      reasons.push(marker.label);
    }
  }

  return { safe: reasons.length === 0, reasons };
}
