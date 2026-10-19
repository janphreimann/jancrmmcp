import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, userClient } from "./supabase.js";

/**
 * Alles, was ein Tool über den aufrufenden Nutzer wissen muss.
 *
 * `db` trägt dessen Supabase-Access-Token, RLS greift also genau wie im
 * Browser — die Zugriffskontrolle liegt damit in der Datenbank und nicht im
 * Tool-Code. `admin` ist die begründete Ausnahme (siehe supabase.ts).
 */
export interface Ctx {
  userId: string;
  orgId: string;
  db: SupabaseClient;
  admin: SupabaseClient;
  /** Für Aufrufe von Edge Functions, die den Nutzer selbst auflösen. */
  accessToken: string;
}

/**
 * Das CRM ist eine Einzelnutzer-Anwendung: ein Owner, eine Organisation. Die
 * Organisation kommt trotzdem nie aus einem Parameter, immer aus der eigenen
 * Zeile — `users` ist per RLS auf den Owner beschränkt, `.eq("id", userId)`
 * grenzt auf die eigene Zeile ein.
 */
export async function buildContext(userId: string, accessToken: string): Promise<Ctx> {
  const db = userClient(accessToken);

  const { data, error } = await db
    .from("users")
    .select("organization_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw new Error(`Could not resolve organization: ${error.message}`);

  // Kein Treffer heißt: dieses Konto ist nicht der Owner des CRM (oder sein
  // Zugang wurde entzogen). Durch RLS sähe es ohnehin nichts, soll aber eine
  // verständliche Meldung bekommen statt überall leerer Ergebnisse.
  if (!data?.organization_id) {
    throw new Error(
      "This account has no access to the CRM. Only the CRM owner can connect this server."
    );
  }

  return { userId, orgId: data.organization_id as string, db, admin, accessToken };
}
