import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";
import { STATUS_TO_DB, TASK_TYPES } from "../constants.js";

export const createTaskSchema = z.object({
  title: z.string().min(1),
  type: z.enum(TASK_TYPES).default("Other"),
  description: z.string().optional().nullable(),
  due_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  due_time: z.string().optional().nullable().describe("HH:MM, defaults to 09:00"),
  priority: z.enum(["High", "Medium", "Low"]).default("Medium"),
  status: z.enum(["Open", "In Progress", "Completed", "Postponed"]).default("Open"),
  contact_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  deal_id: z.string().uuid().optional().nullable(),
});

export async function createTask(args: z.infer<typeof createTaskSchema>) {
  const { due_date, due_time, status, ...fields } = args;

  let dueIso: string | null = null;
  if (due_date) {
    const t = due_time ?? "09:00";
    dueIso = new Date(`${due_date}T${t}:00`).toISOString();
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      ...fields,
      due_date: dueIso,
      status: STATUS_TO_DB[status] ?? "open",
      organization_id: ORG_ID,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Task created successfully" };
}
