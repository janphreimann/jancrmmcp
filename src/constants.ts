export const STAGE_TO_DB: Record<string, string> = {
  Identified: "identified",
  "First Contact": "first_contact",
  "Due Diligence": "due_diligence",
  "Term Sheet": "term_sheet",
  Closing: "closing",
  Completed: "completed",
  Cancelled: "cancelled",
};

export const STAGE_FROM_DB: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_TO_DB).map(([k, v]) => [v, k])
);

export const STATUS_TO_DB: Record<string, string> = {
  Open: "open",
  "In Progress": "in_progress",
  Completed: "completed",
  Postponed: "postponed",
};

export const DEAL_STAGES = Object.keys(STAGE_TO_DB) as [string, ...string[]];

export const INTERACTION_TYPES: [string, ...string[]] = [
  "Phone Call",
  "Meeting — In Person",
  "Video Call",
  "Email Inbound",
  "Email Outbound",
  "Conference",
  "Roadshow",
  "Capital Markets Day",
  "AGM — Annual General Meeting",
  "Other",
];

export const TASK_TYPES: [string, ...string[]] = [
  "Follow-up",
  "Prepare Document",
  "Schedule Call",
  "Schedule Meeting",
  "Analysis",
  "Reporting",
  "Other",
];
