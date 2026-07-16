import { z } from "zod";
import { supabase, ORG_ID, agentMeta } from "../supabase.js";
import { STATUS_TO_DB } from "../constants.js";

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  due_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  due_time: z.string().optional().nullable().describe("HH:MM, defaults to 09:00"),
  priority: z.enum(["High", "Medium", "Low"]).default("Medium"),
  status: z.enum(["Open", "In Progress", "Completed", "Postponed"]).default("Open"),
  reminder: z.enum(["", "15min", "1h", "1d", "2d", "1w"]).optional().nullable().describe("Reminder offset: 15min, 1h, 1d, 2d, 1w"),
  contact_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  deal_id: z.string().uuid().optional().nullable(),
  interaction_id: z.string().uuid().optional().nullable(),
});

export async function createTask(args: z.infer<typeof createTaskSchema>) {
  const { due_date, due_time, status, reminder, ...fields } = args;

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
      reminder: reminder ?? null,
      organization_id: ORG_ID,
      ...agentMeta(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Task created successfully" };
}
