import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { STATUS_TO_DB, STATUS_FROM_DB, TASK_STATUSES } from "../constants.js";

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
  project_id: z.string().uuid().optional().nullable(),
  interaction_id: z.string().uuid().optional().nullable(),
});

export async function createTask(ctx: Ctx, args: z.infer<typeof createTaskSchema>) {
  const { due_date, due_time, status, reminder, ...fields } = args;

  let dueIso: string | null = null;
  if (due_date) {
    const t = due_time ?? "09:00";
    dueIso = new Date(`${due_date}T${t}:00`).toISOString();
  }

  const { data, error } = await ctx.db
    .from("tasks")
    .insert({
      ...fields,
      due_date: dueIso,
      status: STATUS_TO_DB[status] ?? "open",
      reminder: reminder ?? null,
      created_by: ctx.userId,
      ...agentMeta(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Task created successfully" };
}

export const searchTasksSchema = z.object({
  query: z.string().optional().describe("Substring match on the task title"),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(["High", "Medium", "Low"]).optional(),
  contact_id: z.string().uuid().optional().describe("Filter to tasks linked to this contact"),
  company_id: z.string().uuid().optional().describe("Filter to tasks linked to this company"),
  project_id: z.string().uuid().optional().describe("Filter to tasks linked to this project"),
  due_before: z.string().optional().describe("ISO date YYYY-MM-DD, inclusive"),
  due_after: z.string().optional().describe("ISO date YYYY-MM-DD, inclusive"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchTasks(ctx: Ctx, args: z.infer<typeof searchTasksSchema>) {
  let q = ctx.db
    .from("tasks")
    .select("id, title, status, priority, due_date, contact_id, company_id, project_id")
    .is("deleted_at", null)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(args.limit);

  if (args.query) q = q.ilike("title", `%${args.query}%`);
  if (args.status) q = q.eq("status", STATUS_TO_DB[args.status] ?? args.status);
  if (args.priority) q = q.eq("priority", args.priority);
  if (args.contact_id) q = q.eq("contact_id", args.contact_id);
  if (args.company_id) q = q.eq("company_id", args.company_id);
  if (args.project_id) q = q.eq("project_id", args.project_id);
  if (args.due_before) q = q.lte("due_date", `${args.due_before}T23:59:59`);
  if (args.due_after) q = q.gte("due_date", `${args.due_after}T00:00:00`);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  return (data ?? []).map((t: { status: string; [key: string]: unknown }) => ({
    ...t,
    status: STATUS_FROM_DB[t.status] ?? t.status,
  }));
}

export const getTaskSchema = z.object({
  id: z.string().uuid(),
});

export async function getTask(ctx: Ctx, args: z.infer<typeof getTaskSchema>) {
  const { data, error } = await ctx.db
    .from("tasks")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  return { ...data, status: STATUS_FROM_DB[data.status] ?? data.status };
}

export const updateTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().optional(),
  description: z.string().optional().nullable(),
  due_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  due_time: z.string().optional().nullable().describe("HH:MM, defaults to 09:00 if due_date is set"),
  priority: z.enum(["High", "Medium", "Low"]).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  reminder: z.enum(["", "15min", "1h", "1d", "2d", "1w"]).optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  interaction_id: z.string().uuid().optional().nullable(),
});

export async function updateTask(ctx: Ctx, args: z.infer<typeof updateTaskSchema>) {
  const { id, due_date, due_time, status, ...rest } = args;
  const updates: Record<string, unknown> = { ...rest };
  if (status) updates.status = STATUS_TO_DB[status] ?? status;
  if (due_date !== undefined) {
    updates.due_date = due_date ? new Date(`${due_date}T${due_time ?? "09:00"}:00`).toISOString() : null;
  }

  const { data, error } = await ctx.db
    .from("tasks")
    .update(updates)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  // Eine fremde UUID trifft durch die Policy auf null Zeilen. Ohne diese
  // Prüfung meldete das Tool trotzdem Erfolg.
  if (!data?.length) throw new Error(`Task ${id} not found`);
  return { id, message: "Task updated successfully" };
}
