export * from "./client.js";
export * as schema from "./schema/index.js";
// Re-export CRM domain types so consumers can import them directly from "@exec-db/db".
export { SENSITIVE_FLAG_VALUES, TRIAGE_TAG_VALUES, WORK_AREA_VALUES } from "./schema/crm.js";
export type { SensitiveFlag, TriageTag, WorkArea } from "./schema/crm.js";
// Re-export user_pref table for digest infrastructure consumers.
export { userPref } from "./schema/crm.js";
// Re-export PM domain types (K1-K4 — task ergonomics foundation).
export { IMPACT_VALUES, PROJECT_TYPE_VALUES, TASK_STATUS_VALUES } from "./schema/pm.js";
export type { Impact, ProjectType, TaskStatus } from "./schema/pm.js";
