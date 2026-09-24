// Must equal src/modules/projects/constants.ts in ../janreimanncrm —
// test/test-stage-constants.ts fails otherwise. Stages are stored verbatim.
export const PROJECT_STAGES = ["Planning", "Active", "In Review", "Done", "On Hold"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const STATUS_TO_DB: Record<string, string> = {
  Open: "open",
  "In Progress": "in_progress",
  Completed: "completed",
  Postponed: "postponed",
};

export const STATUS_FROM_DB: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_TO_DB).map(([k, v]) => [v, k])
);

export const TASK_STATUSES = Object.keys(STATUS_TO_DB) as [string, ...string[]];

export const INTERACTION_TYPES: [string, ...string[]] = [
  "Phone Call",
  "Meeting",
  "Video Call",
  "Email Inbound",
  "Email Outbound",
  "Conference",
  "Roadshow",
  "Capital Markets Day",
  "AGM — Annual General Meeting",
  "Other",
];
