export * from "./client.js";
export * as schema from "./schema/index.js";
// Re-export CRM domain types so consumers can import them directly from "@exec-db/db".
export { SENSITIVE_FLAG_VALUES } from "./schema/crm.js";
export type { SensitiveFlag } from "./schema/crm.js";
