/**
 * Unit tests for bootstrap CLI pure-function validators.
 *
 * These tests cover the stateless helpers exported from scripts/bootstrap.ts.
 * The interactive flow (TTY prompts, DB connections, pnpm subprocesses) is
 * NOT tested here — that requires a real TTY + live environment.
 */

import { describe, expect, it } from "vitest";
import {
  validateGoogleClientId,
  validateGoogleClientSecret,
  validateResendApiKey,
  parsePostgresUrl,
  extractDomain,
  validateIntakeSecret,
  validateTokenEncKey,
  validateGoogleScopes,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — bootstrap.ts lives outside apps/web; tsx resolves it fine at test-time
} from "../../../scripts/bootstrap";

describe("validateGoogleClientId", () => {
  it("accepts a valid client ID ending in .apps.googleusercontent.com", () => {
    expect(
      validateGoogleClientId(
        "123456789-abcdefg.apps.googleusercontent.com",
      ),
    ).toBe(true);
  });

  it("rejects a plain string with no .apps.googleusercontent.com suffix", () => {
    expect(validateGoogleClientId("not-a-client-id")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validateGoogleClientId("")).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(
      validateGoogleClientId(
        "  123456-abc.apps.googleusercontent.com  ",
      ),
    ).toBe(true);
  });
});

describe("validateGoogleClientSecret", () => {
  it("accepts a secret starting with GOCSPX-", () => {
    expect(validateGoogleClientSecret("GOCSPX-abc123def456")).toBe(true);
  });

  it("rejects a secret with wrong prefix", () => {
    expect(validateGoogleClientSecret("WRONG-abc123")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validateGoogleClientSecret("")).toBe(false);
  });
});

describe("validateResendApiKey", () => {
  it("accepts a key starting with re_", () => {
    expect(validateResendApiKey("re_abc123XYZ")).toBe(true);
  });

  it("rejects a key with wrong prefix", () => {
    expect(validateResendApiKey("sk_abc123")).toBe(false);
  });

  it("trims whitespace before validating", () => {
    expect(validateResendApiKey("  re_abc  ")).toBe(true);
  });
});

describe("parsePostgresUrl", () => {
  it("accepts postgres:// URL", () => {
    expect(
      parsePostgresUrl("postgres://user:pass@localhost:5432/mydb"),
    ).toBe(true);
  });

  it("accepts postgresql:// URL", () => {
    expect(
      parsePostgresUrl("postgresql://user:pass@host:5432/db"),
    ).toBe(true);
  });

  it("rejects http:// URL", () => {
    expect(parsePostgresUrl("http://example.com")).toBe(false);
  });

  it("rejects a plain string", () => {
    expect(parsePostgresUrl("not-a-url")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(parsePostgresUrl("")).toBe(false);
  });
});

describe("extractDomain", () => {
  it("extracts domain from email address", () => {
    expect(extractDomain("digests@mail.example.com")).toBe("mail.example.com");
  });

  it("extracts hostname from a URL", () => {
    expect(extractDomain("https://app.example.com/path")).toBe(
      "app.example.com",
    );
  });

  it("returns bare domain unchanged", () => {
    expect(extractDomain("mail.example.com")).toBe("mail.example.com");
  });

  it("trims whitespace before extracting", () => {
    expect(extractDomain("  user@sub.domain.com  ")).toBe("sub.domain.com");
  });
});

describe("validateIntakeSecret", () => {
  it("accepts a 64-character hex string", () => {
    expect(
      validateIntakeSecret(
        "a".repeat(32) + "b".repeat(32),
      ),
    ).toBe(true);
  });

  it("rejects a 63-character hex string (too short)", () => {
    expect(validateIntakeSecret("a".repeat(63))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(validateIntakeSecret("z".repeat(64))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validateIntakeSecret("")).toBe(false);
  });
});

describe("validateTokenEncKey", () => {
  it("accepts a valid 44-char base64 string (32 bytes base64)", () => {
    // 32 random bytes base64-encoded = 44 chars ending with '='
    expect(
      validateTokenEncKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    ).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(validateTokenEncKey("")).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(validateTokenEncKey("abc=")).toBe(false);
  });
});

describe("validateGoogleScopes", () => {
  const validScopes = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ].join(" ");

  it("accepts the three required scopes", () => {
    expect(validateGoogleScopes(validScopes)).toBe(true);
  });

  it("rejects if gmail.send scope is present (AD-004)", () => {
    const withSend =
      validScopes +
      " https://www.googleapis.com/auth/gmail.send";
    expect(validateGoogleScopes(withSend)).toBe(false);
  });

  it("rejects if a required scope is missing", () => {
    const missingCompose =
      "https://www.googleapis.com/auth/calendar.readonly " +
      "https://www.googleapis.com/auth/gmail.readonly";
    expect(validateGoogleScopes(missingCompose)).toBe(false);
  });

  it("rejects an empty scope string", () => {
    expect(validateGoogleScopes("")).toBe(false);
  });
});
