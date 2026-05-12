import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadServiceAccountKey } from "@/lib/audit-sheet";

const ENV_BASE64 = "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_BASE64";
const ENV_PATH = "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH";

const ORIGINAL_BASE64 = process.env[ENV_BASE64];
const ORIGINAL_PATH = process.env[ENV_PATH];

const VALID_KEY = {
  client_email: "writer@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n",
};

beforeEach(() => {
  delete process.env[ENV_BASE64];
  delete process.env[ENV_PATH];
});

afterEach(() => {
  if (ORIGINAL_BASE64 === undefined) delete process.env[ENV_BASE64];
  else process.env[ENV_BASE64] = ORIGINAL_BASE64;
  if (ORIGINAL_PATH === undefined) delete process.env[ENV_PATH];
  else process.env[ENV_PATH] = ORIGINAL_PATH;
});

describe("loadServiceAccountKey", () => {
  it("returns null when neither env var is set (dev / CI default)", () => {
    expect(loadServiceAccountKey()).toBeNull();
  });

  it("decodes BASE64 env var (Vercel-compatible path)", () => {
    process.env[ENV_BASE64] = Buffer.from(JSON.stringify(VALID_KEY)).toString("base64");
    const key = loadServiceAccountKey();
    expect(key).not.toBeNull();
    expect(key!.client_email).toBe(VALID_KEY.client_email);
    expect(key!.private_key).toBe(VALID_KEY.private_key);
  });

  it("returns null when BASE64 decodes but lacks client_email", () => {
    process.env[ENV_BASE64] = Buffer.from(JSON.stringify({ private_key: "x" })).toString("base64");
    expect(loadServiceAccountKey()).toBeNull();
  });

  it("returns null when BASE64 decodes but lacks private_key", () => {
    process.env[ENV_BASE64] = Buffer.from(JSON.stringify({ client_email: "x" })).toString("base64");
    expect(loadServiceAccountKey()).toBeNull();
  });

  it("returns null when BASE64 is malformed", () => {
    process.env[ENV_BASE64] = "not-valid-base64-json!!!";
    expect(loadServiceAccountKey()).toBeNull();
  });

  it("prefers BASE64 over PATH when both are set", () => {
    process.env[ENV_BASE64] = Buffer.from(JSON.stringify(VALID_KEY)).toString("base64");
    process.env[ENV_PATH] = "/nonexistent/path/that/would/fail";
    const key = loadServiceAccountKey();
    expect(key).not.toBeNull();
    expect(key!.client_email).toBe(VALID_KEY.client_email);
  });

  it("returns null when PATH points to a nonexistent file", () => {
    process.env[ENV_PATH] = "/definitely/not/a/real/path.json";
    expect(loadServiceAccountKey()).toBeNull();
  });
});
