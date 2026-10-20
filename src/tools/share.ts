import { z } from "zod";
import type { Ctx } from "../context.js";
import { callEdgeFunction } from "./edge.js";

// share_status: who can see what in the Share portal, and what they did.
//
// Two sources, both with the caller's token:
// - share_events (the CRM's history copy, RLS) for the last openings and
//   comments;
// - the edge function share-admin, read actions only, for current access —
//   Share is the source of truth and the CRM stores none of it (CLAUDE.md
//   "Share portal"). share-admin checks getUser() + ownerSessionOk(), which
//   accepts registered MCP sessions.
//
// Never returned: one-time passwords (only issue_otp actions yield them, and
// those are not called), signed or preview URLs, item links. Everything from
// Share is whitelisted field by field below.

/** The share-admin actions this tool may call — nothing that writes or hands out a secret. */
export const SHARE_READ_ACTIONS = ["recipient.get", "catalog.list", "item.get"] as const;
type ShareReadAction = (typeof SHARE_READ_ACTIONS)[number];

export const shareStatusSchema = z.object({
  contact_id: z.string().uuid().optional().describe("A contact: their Share access, the items shared with them and their recent activity"),
  document_id: z.string().uuid().optional().describe("A CRM document: the Share item made from it, who has it, and recent activity on it"),
});

const EVENT_LIMIT = 15;
const BODY_MAX = 300;

async function shareAdmin(ctx: Ctx, action: ShareReadAction, params: Record<string, unknown>) {
  const { ok, status, json } = await callEdgeFunction<Record<string, unknown>>(ctx, "share-admin", { action, params });
  if (!ok || json.ok === false) {
    const code = typeof json.error === "string" ? json.error : `HTTP ${status}`;
    if (code === "share_not_configured") throw new Error("The Share portal is not configured for this CRM.");
    throw new Error(`Share portal: ${code}`);
  }
  return json;
}

type EventRow = {
  kind: string; occurred_at: string; item_title: string | null; document_id: string | null;
  author: string | null; body: string | null; thread_resolved: boolean | null;
  contacts?: { first_name: string | null; last_name: string | null } | null;
};

function compactEvent(e: EventRow, withContact: boolean) {
  const name = e.contacts ? `${e.contacts.first_name ?? ""} ${e.contacts.last_name ?? ""}`.trim() : "";
  return {
    kind: e.kind,
    at: e.occurred_at,
    ...(withContact && name ? { contact: name } : {}),
    ...(e.item_title ? { item: e.item_title } : {}),
    ...(e.kind === "comment"
      ? {
          author: e.author,
          body: e.body && e.body.length > BODY_MAX ? `${e.body.slice(0, BODY_MAX)}…` : e.body,
          ...(e.thread_resolved ? { resolved: true } : {}),
        }
      : {}),
  };
}

type Recipient = {
  status?: string; access_expires_at?: string | null; password_set?: boolean; otp_pending?: boolean;
  last_login_at?: string | null; shares?: { item_id: string; can_comment: boolean }[];
};
type CatalogItem = { id: string; title: string; type: string; archived: boolean; crm_document_id: string | null };

/** Current access of one person, whitelisted (no password, no link). */
export function compactRecipient(r: Recipient | null, catalog: CatalogItem[]) {
  if (!r) return null;
  const titles = new Map(catalog.map((i) => [i.id, i]));
  return {
    status: r.status,
    access_expires_at: r.access_expires_at ?? null,
    password_set: !!r.password_set,
    ...(r.otp_pending ? { one_time_password_pending: true } : {}),
    last_login_at: r.last_login_at ?? null,
    shared_items: (r.shares ?? []).map((s) => {
      const item = titles.get(s.item_id);
      return {
        title: item?.title ?? null,
        type: item?.type ?? null,
        ...(item?.crm_document_id ? { document_id: item.crm_document_id } : {}),
        ...(item?.archived ? { archived: true } : {}),
        can_comment: s.can_comment,
      };
    }),
  };
}

type ItemShare = {
  can_comment: boolean;
  person?: { name?: string; email?: string | null; crm_contact_id?: string | null; status?: string; last_login_at?: string | null; access_expires_at?: string | null };
};

/** The Share item made from a document and who has it, whitelisted. */
export function compactItem(item: Record<string, unknown>, shares: ItemShare[]) {
  return {
    title: item.title,
    type: item.type,
    ...(item.archived ? { archived: true } : {}),
    version: item.version ?? null,
    open_comments: item.open_comment_count ?? 0,
    unread_comments: item.unread_comment_count ?? 0,
    shared_with: shares.map((s) => ({
      name: s.person?.name ?? null,
      email: s.person?.email ?? null,
      ...(s.person?.crm_contact_id ? { contact_id: s.person.crm_contact_id } : {}),
      status: s.person?.status ?? null,
      last_login_at: s.person?.last_login_at ?? null,
      ...(s.person?.access_expires_at ? { access_expires_at: s.person.access_expires_at } : {}),
      can_comment: s.can_comment,
    })),
  };
}

export async function shareStatus(ctx: Ctx, args: z.infer<typeof shareStatusSchema>) {
  if (!!args.contact_id === !!args.document_id) throw new Error("Pass exactly one of contact_id or document_id.");
  const events = ctx.db
    .from("share_events")
    .select("kind, occurred_at, item_title, document_id, author, body, thread_resolved, contacts:contact_id(first_name, last_name)")
    .order("occurred_at", { ascending: false })
    .limit(EVENT_LIMIT);

  if (args.contact_id) {
    // The contact through RLS first: a foreign or deleted id is "not found",
    // not an empty Share answer.
    const { data: contact, error } = await ctx.db
      .from("contacts").select("id, first_name, last_name").eq("id", args.contact_id).is("deleted_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    if (!contact) throw new Error(`Contact ${args.contact_id} not found.`);

    const [ev, recipient, catalog] = await Promise.all([
      events.eq("contact_id", args.contact_id),
      shareAdmin(ctx, "recipient.get", { contact_id: args.contact_id }),
      shareAdmin(ctx, "catalog.list", { include_archived: true }),
    ]);
    if (ev.error) throw new Error(ev.error.message);
    return {
      contact: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
      access: compactRecipient((recipient.recipient ?? null) as Recipient | null, (catalog.items ?? []) as CatalogItem[]),
      recent_activity: ((ev.data ?? []) as unknown as EventRow[]).map((e) => compactEvent(e, false)),
    };
  }

  const documentId = args.document_id!;
  const { data: doc, error } = await ctx.db
    .from("documents").select("id, file_name").eq("id", documentId).is("deleted_at", null).maybeSingle();
  if (error) throw new Error(error.message);
  if (!doc) throw new Error(`Document ${documentId} not found.`);

  const [ev, catalog] = await Promise.all([
    events.eq("document_id", documentId),
    shareAdmin(ctx, "catalog.list", { include_archived: true }),
  ]);
  if (ev.error) throw new Error(ev.error.message);
  const recent_activity = ((ev.data ?? []) as unknown as EventRow[]).map((e) => compactEvent(e, true));

  const item = ((catalog.items ?? []) as CatalogItem[]).find((i) => i.crm_document_id === documentId);
  if (!item) return { document: doc.file_name, shared: false, item: null, recent_activity };

  const detail = await shareAdmin(ctx, "item.get", { item_id: item.id });
  return {
    document: doc.file_name,
    shared: true,
    item: compactItem((detail.item ?? {}) as Record<string, unknown>, (detail.shares ?? []) as ItemShare[]),
    recent_activity,
  };
}
