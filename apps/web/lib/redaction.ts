// Deterministic, pure, regex-based redaction filter.
//
// Required by SY-016 (W10.1 / W10.4): every string headed for any LLM is run
// through this filter first. The filter is intentionally regex-only — no
// network, no clock, no randomness — so that the same input always produces
// the same output and the same `classesHit` list. This property is what makes
// it auditable and unit-testable.
//
// Six classes covered (W10.4 lists seven; "names" is explicitly out of scope
// for v1, see KNOWN GAP below):
//
//   1. PHI                  -> <PHI>   ICD-10, MRN, common clinical phrases
//   2. PI                   -> <PI>    Passports (US), DOB near keyword
//   3. Banking              -> <BANK>  ABA routing, credit card, IBAN, "acct #"
//   4. SSN                  -> <SSN>   US SSN with dashes or spaces
//   5. Driver license       -> <DL>    State-prefix patterns (CA/NY/TX/FL/WA)
//   6. Non-public address   -> <ADDR>  Email + US-style street address; an
//                                       env-driven allowlist controls which
//                                       email domains pass through.
//
// Replacement tokens are themselves type-safe and contain no original content,
// so the redacted string is safe to send to a model without leaking material.
//
// KNOWN GAP — names. Personal names cannot be detected reliably with regex
// without unacceptable false-positive rates ("Brooklyn", "Sky", "April") and
// false negatives (anything non-Anglo). A future pass behind a feature flag
// will route the redacted output through a small classifier-style LLM call
// to flag names; that work is intentionally deferred.
// TODO(future): name-class redaction via secondary LLM pass behind a flag.
//
// USAGE
//   import { redact } from "@/lib/redaction";
//   const { redacted, classesHit } = redact(userText);
//
// Composition with `safeAnthropic` in `./anthropic.ts` is the *only* sanctioned
// way to call the Anthropic SDK from this app. Any direct SDK use bypasses
// SY-016 and must fail review.

export type RedactionClass =
  | "phi"
  | "pi"
  | "banking"
  | "ssn"
  | "drivers_license"
  | "non_public_address";

export interface RedactionResult {
  redacted: string;
  classesHit: RedactionClass[];
}

const TOKENS: Record<RedactionClass, string> = {
  phi: "<PHI>",
  pi: "<PI>",
  banking: "<BANK>",
  ssn: "<SSN>",
  drivers_license: "<DL>",
  non_public_address: "<ADDR>",
};

// ---------------------------------------------------------------------------
// Email allowlist (W10.4: "non-public business addresses or emails")
// ---------------------------------------------------------------------------
//
// Default = empty allowlist => every email is masked. Production loads a
// comma-separated list of public domains from REDACTION_PUBLIC_DOMAINS. We
// read the env var at call time (not module load time) so tests can mutate
// it deterministically.

function publicDomains(): Set<string> {
  const raw = process.env["REDACTION_PUBLIC_DOMAINS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Luhn validator — used for credit card and ABA routing checks to cut down on
// false positives from bare 9- or 16-digit runs.
// ---------------------------------------------------------------------------

function luhnValid(digits: string): boolean {
  // Strip non-digits, then run the standard Luhn mod-10.
  const ds = digits.replace(/\D/g, "");
  if (ds.length < 13 || ds.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = ds.length - 1; i >= 0; i--) {
    const ch = ds.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let n = ch;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ABA uses a different mod-10 weighting than Luhn. Spec'd at:
//   3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)
function abaValid(nine: string): boolean {
  if (!/^\d{9}$/.test(nine)) return false;
  const d = nine.split("").map(Number) as number[];
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let total = 0;
  for (let i = 0; i < 9; i++) total += d[i]! * w[i]!;
  return total % 10 === 0;
}

// ---------------------------------------------------------------------------
// Patterns. Each pattern lists the class it belongs to and a replacer.
// They are applied in order; later patterns operate on already-redacted
// strings, which means once a span has been replaced by `<TOKEN>` it cannot
// match again. We deliberately apply the most specific patterns first
// (SSN before banking, banking before generic digit runs).
// ---------------------------------------------------------------------------

interface Pattern {
  class: RedactionClass;
  // returns the replacement string, or null to skip this match
  apply: (input: string) => { output: string; hit: boolean };
}

function simpleReplace(
  input: string,
  re: RegExp,
  token: string,
): { output: string; hit: boolean } {
  let hit = false;
  const output = input.replace(re, () => {
    hit = true;
    return token;
  });
  return { output, hit };
}

// SSN: 3-2-4 with - or space separator. Reject 000-/666-/9xx- per SSA rules
// to cut down false positives on lookalike numerics like "100-20-3000" being
// a product code (we DO match that — strict SSA filtering would over-trim;
// the rule of thumb here is "if it looks like an SSN, mask it").
const RE_SSN = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g;

// US passport: a 9-digit run preceded by an explicit "passport" keyword to
// avoid eating every 9-digit number in sight (those would match ABA, EIN, etc.).
const RE_PASSPORT =
  /\b(?:passport(?:\s+(?:no\.?|number|#))?\s*[:#]?\s*)([A-Z0-9]{6,9})\b/gi;

// DOB: YYYY-MM-DD or MM/DD/YYYY in the vicinity (≤30 chars) of "DOB" or
// "birth" / "born". The keyword anchor is what saves us from masking every
// date in a calendar export.
const RE_DOB =
  /\b(?:DOB|D\.O\.B\.|date\s+of\s+birth|birth\s*date|born(?:\s+on)?)\b[^.\n]{0,30}?(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/gi;

// ICD-10: letter, two digits, optional dot + 1-4 alphanumerics. Real codes
// always start with A–T or V–Z and have a digit in position 2. We keep it
// loose — every code we'd see clinically matches.
const RE_ICD10 = /\b[A-TV-Z]\d{2}(?:\.[A-Z0-9]{1,4})?\b/g;

// MRN — explicit "MRN" / "medical record" prefix only. Bare 6-10 digit runs
// would generate too many false positives on order numbers, ticket IDs, etc.
const RE_MRN = /\b(?:MRN|medical\s+record(?:\s+(?:no|number|#))?)\s*[:#]?\s*\d{6,10}\b/gi;

// Clinical phrasing markers — short hand-tuned list. False-positive risk is
// real (a recipe might say "patient zero"), but the cost of leaking PHI is
// higher than the cost of an over-eager mask in a model prompt.
const RE_CLINICAL = new RegExp(
  String.raw`\b(?:diagnosed\s+with|prescribed|admitted\s+to\s+(?:the\s+)?(?:hospital|ER|ICU)|patient\s+(?:complains|presents|history)|chief\s+complaint|differential\s+diagnosis|HIV(?:\+|-positive|\s+positive)|cancer\s+(?:stage|patient)|chemotherapy|dialysis)\b`,
  "gi",
);

// Banking — IBAN, then credit card (Luhn-gated), then ABA (Luhn-like-gated),
// then "acct #" prefixed account numbers.
const RE_IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const RE_CC = /\b(?:\d[ -]?){12,18}\d\b/g;
const RE_ABA = /\b\d{9}\b/g;
const RE_ACCT =
  /\b(?:acct|account)(?:\s+(?:no\.?|number))?\s*[:#]\s*[A-Z0-9-]{4,20}\b/gi;

// Driver license — state-prefix patterns for a representative subset:
//   CA  : "CA DL"  + 1 letter + 7 digits      (e.g. "CA DL D1234567")
//   NY  : "NY DL"  + 9 digits
//   TX  : "TX DL"  + 8 digits
//   FL  : "FL DL"  + 1 letter + 12 digits
//   WA  : "WA DL"  + WDL + 9 alphanumerics
// Documented intentionally as a representative list, not exhaustive. Other
// states fall through unless the text also has another redaction trigger.
const RE_DL = new RegExp(
  String.raw`\b(?:` +
    String.raw`CA\s*(?:DL|driver\s+license)\s*[:#]?\s*[A-Z]\d{7}` +
    String.raw`|NY\s*(?:DL|driver\s+license)\s*[:#]?\s*\d{9}` +
    String.raw`|TX\s*(?:DL|driver\s+license)\s*[:#]?\s*\d{8}` +
    String.raw`|FL\s*(?:DL|driver\s+license)\s*[:#]?\s*[A-Z]\d{12}` +
    String.raw`|WA\s*(?:DL|driver\s+license)\s*[:#]?\s*WDL[A-Z0-9]{9}` +
    String.raw`)\b`,
  "gi",
);

// US street address — number, street word, suffix. Loose by design.
const RE_STREET =
  /\b\d{1,6}\s+(?:[A-Z][a-zA-Z]+\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Terrace|Ter\.?|Parkway|Pkwy\.?)\b/g;

// Email — capture local + domain so the allowlist can decide.
const RE_EMAIL = /\b([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

// ---------------------------------------------------------------------------
// Pattern application order. Order matters: replacing SSN first means the
// 9-digit ABA pass below cannot re-match "123-45-6789" once it's been
// rewritten to "<SSN>".
// ---------------------------------------------------------------------------

const PATTERNS: Pattern[] = [
  // PHI
  {
    class: "phi",
    apply: (s) => simpleReplace(s, RE_MRN, TOKENS.phi),
  },
  {
    class: "phi",
    apply: (s) => simpleReplace(s, RE_ICD10, TOKENS.phi),
  },
  {
    class: "phi",
    apply: (s) => simpleReplace(s, RE_CLINICAL, TOKENS.phi),
  },

  // PI
  {
    class: "pi",
    apply: (s) => {
      let hit = false;
      const out = s.replace(RE_DOB, (whole, _date: string) => {
        // We mask the WHOLE matched region, not just the captured date,
        // because the keyword + date together is what discloses the DOB.
        hit = true;
        return TOKENS.pi;
      });
      return { output: out, hit };
    },
  },
  {
    class: "pi",
    apply: (s) => simpleReplace(s, RE_PASSPORT, TOKENS.pi),
  },

  // SSN — must run before banking so 9-digit SSNs aren't mistaken for ABA.
  {
    class: "ssn",
    apply: (s) => simpleReplace(s, RE_SSN, TOKENS.ssn),
  },

  // Banking
  {
    class: "banking",
    apply: (s) => simpleReplace(s, RE_IBAN, TOKENS.banking),
  },
  {
    class: "banking",
    apply: (s) => {
      let hit = false;
      const out = s.replace(RE_CC, (m) => {
        if (luhnValid(m)) {
          hit = true;
          return TOKENS.banking;
        }
        return m;
      });
      return { output: out, hit };
    },
  },
  {
    class: "banking",
    apply: (s) => {
      let hit = false;
      const out = s.replace(RE_ABA, (m) => {
        if (abaValid(m)) {
          hit = true;
          return TOKENS.banking;
        }
        return m;
      });
      return { output: out, hit };
    },
  },
  {
    class: "banking",
    apply: (s) => simpleReplace(s, RE_ACCT, TOKENS.banking),
  },

  // Driver license
  {
    class: "drivers_license",
    apply: (s) => simpleReplace(s, RE_DL, TOKENS.drivers_license),
  },

  // Non-public address / email
  {
    class: "non_public_address",
    apply: (s) => simpleReplace(s, RE_STREET, TOKENS.non_public_address),
  },
  {
    class: "non_public_address",
    apply: (s) => {
      const allow = publicDomains();
      let hit = false;
      const out = s.replace(RE_EMAIL, (m, _local: string, domain: string) => {
        if (allow.has(domain.toLowerCase())) return m;
        hit = true;
        return TOKENS.non_public_address;
      });
      return { output: out, hit };
    },
  },
];

/**
 * Run the deterministic redaction filter over `input`.
 *
 * The function is pure: same input + same `REDACTION_PUBLIC_DOMAINS` env
 * always returns the same output. No I/O, no clocks, no randomness.
 *
 * @returns `redacted` text (safe to send to an LLM) and `classesHit`, the
 *          unique set of {@link RedactionClass} values triggered, in
 *          declaration order.
 */
export function redact(input: string): RedactionResult {
  if (input == null || input === "") {
    return { redacted: input ?? "", classesHit: [] };
  }

  let current = input;
  const seen = new Set<RedactionClass>();
  // Maintain declaration-order of the union for stable output.
  const order: RedactionClass[] = [
    "phi",
    "pi",
    "banking",
    "ssn",
    "drivers_license",
    "non_public_address",
  ];

  for (const p of PATTERNS) {
    const { output, hit } = p.apply(current);
    current = output;
    if (hit) seen.add(p.class);
  }

  const classesHit = order.filter((c) => seen.has(c));
  return { redacted: current, classesHit };
}
