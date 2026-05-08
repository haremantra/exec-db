import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { redact, type RedactionClass } from "@/lib/redaction";

const ORIGINAL_ENV = process.env["REDACTION_PUBLIC_DOMAINS"];

beforeEach(() => {
  // Default: allowlist is empty so every email is masked.
  delete process.env["REDACTION_PUBLIC_DOMAINS"];
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env["REDACTION_PUBLIC_DOMAINS"];
  } else {
    process.env["REDACTION_PUBLIC_DOMAINS"] = ORIGINAL_ENV;
  }
});

function hits(classes: RedactionClass[], target: RedactionClass): boolean {
  return classes.includes(target);
}

describe("redaction — PHI", () => {
  it("masks ICD-10 codes (positive)", () => {
    const { redacted, classesHit } = redact("Patient note: J45.909 follow-up.");
    expect(redacted).toContain("<PHI>");
    expect(redacted).not.toContain("J45.909");
    expect(hits(classesHit, "phi")).toBe(true);
  });

  it("masks MRN with explicit prefix (positive)", () => {
    const { redacted, classesHit } = redact("Pull chart for MRN: 12345678 today.");
    expect(redacted).toContain("<PHI>");
    expect(redacted).not.toContain("12345678");
    expect(hits(classesHit, "phi")).toBe(true);
  });

  it("masks clinical phrasing (positive)", () => {
    const { redacted, classesHit } = redact(
      "Customer was diagnosed with hypertension last spring.",
    );
    expect(redacted).toContain("<PHI>");
    expect(hits(classesHit, "phi")).toBe(true);
  });

  it("does NOT mask innocuous strings that look like ICD-10 (negative)", () => {
    // Lowercase letter + digits, no clinical context — pure product code.
    const { redacted, classesHit } = redact("Order code j45 shipped on Tuesday.");
    expect(redacted).toBe("Order code j45 shipped on Tuesday.");
    expect(hits(classesHit, "phi")).toBe(false);
  });

  it("does NOT mask raw 8-digit numbers without MRN prefix (negative)", () => {
    const { redacted, classesHit } = redact("Ticket 12345678 closed.");
    expect(redacted).toBe("Ticket 12345678 closed.");
    expect(hits(classesHit, "phi")).toBe(false);
  });
});

describe("redaction — PI", () => {
  it("masks DOB near keyword (positive, slash format)", () => {
    const { redacted, classesHit } = redact("DOB: 04/12/1981 — file complete.");
    expect(redacted).toContain("<PI>");
    expect(redacted).not.toContain("04/12/1981");
    expect(hits(classesHit, "pi")).toBe(true);
  });

  it("masks DOB near 'born' keyword (positive, ISO format)", () => {
    const { redacted, classesHit } = redact("She was born on 1981-04-12 in Ohio.");
    expect(redacted).toContain("<PI>");
    expect(hits(classesHit, "pi")).toBe(true);
  });

  it("masks passport with explicit keyword (positive)", () => {
    const { redacted, classesHit } = redact("Passport No: A12345678 valid through 2030.");
    expect(redacted).toContain("<PI>");
    expect(redacted).not.toContain("A12345678");
    expect(hits(classesHit, "pi")).toBe(true);
  });

  it("does NOT mask a plain date with no DOB context (negative)", () => {
    const { redacted, classesHit } = redact("The meeting is on 04/12/2026 at noon.");
    expect(redacted).toBe("The meeting is on 04/12/2026 at noon.");
    expect(hits(classesHit, "pi")).toBe(false);
  });
});

describe("redaction — Banking", () => {
  it("masks a Luhn-valid credit card (positive)", () => {
    // 4111 1111 1111 1111 is the canonical Visa test number (Luhn-valid).
    const { redacted, classesHit } = redact("Charge to 4111 1111 1111 1111 next.");
    expect(redacted).toContain("<BANK>");
    expect(redacted).not.toContain("4111 1111 1111 1111");
    expect(hits(classesHit, "banking")).toBe(true);
  });

  it("masks a Luhn-valid ABA routing number (positive)", () => {
    // 011000015 is a published Federal Reserve Bank of Boston test routing.
    const { redacted, classesHit } = redact("Wire to ABA 011000015 today.");
    expect(redacted).toContain("<BANK>");
    expect(hits(classesHit, "banking")).toBe(true);
  });

  it("masks IBAN format (positive)", () => {
    const { redacted, classesHit } = redact("Pay GB29NWBK60161331926819 by EOD.");
    expect(redacted).toContain("<BANK>");
    expect(redacted).not.toContain("GB29NWBK60161331926819");
    expect(hits(classesHit, "banking")).toBe(true);
  });

  it("masks 'acct #' prefixed account numbers (positive)", () => {
    const { redacted, classesHit } = redact("Use acct #00123456 for the deposit.");
    expect(redacted).toContain("<BANK>");
    expect(redacted).not.toContain("00123456");
    expect(hits(classesHit, "banking")).toBe(true);
  });

  it("does NOT mask a non-Luhn 16-digit run (negative)", () => {
    // Random-looking but not Luhn-valid; should pass through.
    const { redacted, classesHit } = redact("Order id 1234567812345678 in queue.");
    expect(redacted).toContain("1234567812345678");
    expect(hits(classesHit, "banking")).toBe(false);
  });

  it("does NOT mask an arbitrary 9-digit run that fails ABA check (negative)", () => {
    // 999999999 fails the ABA mod-10.
    const { redacted, classesHit } = redact("Lookup id 999999999 returned 0 rows.");
    expect(redacted).toContain("999999999");
    expect(hits(classesHit, "banking")).toBe(false);
  });
});

describe("redaction — SSN", () => {
  it("masks dashed SSN (positive)", () => {
    const { redacted, classesHit } = redact("SSN on file: 123-45-6789, verified.");
    expect(redacted).toContain("<SSN>");
    expect(redacted).not.toContain("123-45-6789");
    expect(hits(classesHit, "ssn")).toBe(true);
  });

  it("masks space-separated SSN (positive)", () => {
    const { redacted, classesHit } = redact("Confirm 123 45 6789 with HR.");
    expect(redacted).toContain("<SSN>");
    expect(hits(classesHit, "ssn")).toBe(true);
  });

  it("does NOT mask an unrelated number sequence (negative)", () => {
    const { redacted, classesHit } = redact("Build 123456789 promoted to staging.");
    expect(redacted).toContain("123456789");
    expect(hits(classesHit, "ssn")).toBe(false);
  });
});

describe("redaction — Driver License", () => {
  it("masks a CA driver license (positive)", () => {
    const { redacted, classesHit } = redact("CA DL D1234567 expires next year.");
    expect(redacted).toContain("<DL>");
    expect(redacted).not.toContain("D1234567");
    expect(hits(classesHit, "drivers_license")).toBe(true);
  });

  it("masks an NY driver license (positive)", () => {
    const { redacted, classesHit } = redact("NY driver license 123456789 on record.");
    expect(redacted).toContain("<DL>");
    expect(hits(classesHit, "drivers_license")).toBe(true);
  });

  it("does NOT mask a generic ID without state-prefix context (negative)", () => {
    const { redacted, classesHit } = redact("Card holder ID D1234567 issued.");
    expect(redacted).toContain("D1234567");
    expect(hits(classesHit, "drivers_license")).toBe(false);
  });
});

describe("redaction — non-public address/email", () => {
  it("masks a US street address (positive)", () => {
    const { redacted, classesHit } = redact("Mail to 1600 Pennsylvania Avenue today.");
    expect(redacted).toContain("<ADDR>");
    expect(redacted).not.toContain("Pennsylvania Avenue");
    expect(hits(classesHit, "non_public_address")).toBe(true);
  });

  it("masks all emails when allowlist is empty (positive)", () => {
    const { redacted, classesHit } = redact("Reach me at alice@example.com please.");
    expect(redacted).toContain("<ADDR>");
    expect(redacted).not.toContain("alice@example.com");
    expect(hits(classesHit, "non_public_address")).toBe(true);
  });

  it("passes through emails on the public-domain allowlist (negative)", () => {
    process.env["REDACTION_PUBLIC_DOMAINS"] = "press.example.com,public.org";
    const { redacted, classesHit } = redact("CC press@press.example.com on the announcement.");
    expect(redacted).toContain("press@press.example.com");
    expect(hits(classesHit, "non_public_address")).toBe(false);
  });

  it("masks emails NOT on the allowlist even when one is set (mixed)", () => {
    process.env["REDACTION_PUBLIC_DOMAINS"] = "press.example.com";
    const { redacted } = redact(
      "Send to press@press.example.com and copy alice@private.test.",
    );
    expect(redacted).toContain("press@press.example.com");
    expect(redacted).toContain("<ADDR>");
    expect(redacted).not.toContain("alice@private.test");
  });
});

describe("redaction — composite + invariants", () => {
  it("masks all three classes when mixed in one input", () => {
    const input =
      "Patient (DOB: 04/12/1981) MRN: 1234567 wired via ABA 011000015 yesterday.";
    const { redacted, classesHit } = redact(input);

    expect(redacted).toContain("<PI>");
    expect(redacted).toContain("<PHI>");
    expect(redacted).toContain("<BANK>");
    expect(redacted).not.toContain("1234567");
    expect(redacted).not.toContain("011000015");
    expect(redacted).not.toContain("04/12/1981");

    expect(hits(classesHit, "pi")).toBe(true);
    expect(hits(classesHit, "phi")).toBe(true);
    expect(hits(classesHit, "banking")).toBe(true);
  });

  it("masks five classes in one input and reports them all", () => {
    const input = [
      "MRN: 9876543",
      "SSN 123-45-6789",
      "card 4111 1111 1111 1111",
      "CA DL D1234567",
      "send to alice@example.com",
    ].join("; ");
    const { redacted, classesHit } = redact(input);

    expect(redacted).toContain("<PHI>");
    expect(redacted).toContain("<SSN>");
    expect(redacted).toContain("<BANK>");
    expect(redacted).toContain("<DL>");
    expect(redacted).toContain("<ADDR>");

    expect(classesHit.sort()).toEqual(
      (
        ["phi", "ssn", "banking", "drivers_license", "non_public_address"] as RedactionClass[]
      ).sort(),
    );
  });

  it("is deterministic — same input twice yields identical output", () => {
    const input =
      "Customer was diagnosed with cancer. SSN 123-45-6789. DOB: 1981-04-12. Mail 1600 Pennsylvania Avenue.";
    const a = redact(input);
    const b = redact(input);
    expect(a.redacted).toBe(b.redacted);
    expect(a.classesHit).toEqual(b.classesHit);
  });

  it("returns empty result for empty input", () => {
    const { redacted, classesHit } = redact("");
    expect(redacted).toBe("");
    expect(classesHit).toEqual([]);
  });

  it("returns input unchanged when no class matches", () => {
    const { redacted, classesHit } = redact("Plain text with nothing to mask.");
    expect(redacted).toBe("Plain text with nothing to mask.");
    expect(classesHit).toEqual([]);
  });

  it("uses typed tokens (no raw sensitive content) in output", () => {
    const { redacted } = redact("SSN 123-45-6789 and card 4111 1111 1111 1111.");
    // Tokens must be exactly the documented strings.
    expect(redacted).toMatch(/<SSN>/);
    expect(redacted).toMatch(/<BANK>/);
    expect(redacted).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });
});
