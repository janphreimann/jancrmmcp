import type { SupabaseClient } from "@supabase/supabase-js";

/** Supabase-Sitzung des angemeldeten Nutzers. */
export interface Session {
  sub: string;   // Supabase-User-ID
  at: string;    // Access-Token (JWT, ~1 h)
  rt: string;    // Refresh-Token
}

/** Claims des Supabase-Access-Tokens, ohne Prüfung der Signatur (die prüft Supabase). */
export function accessTokenClaims(supabaseAccessToken: string): { exp?: number; session_id?: string } | null {
  try {
    return JSON.parse(Buffer.from(supabaseAccessToken.split(".")[1], "base64url").toString()) as {
      exp?: number;
      session_id?: string;
    };
  } catch {
    return null;
  }
}

export interface MintDeps {
  /** service_role — generateLink, getUserById, register_mcp_session, signOut. */
  admin: SupabaseClient;
  /** Frischer anonymer Client pro Aufruf (verifyOtp legt die Sitzung im Client ab). */
  anon: () => SupabaseClient;
}

export type MintResult =
  | { ok: true; session: Session; sessionId: string }
  | { ok: false; reason: "user" | "link" | "verify" | "register" };

/**
 * Erzeugt für einen bereits identifizierten Nutzer eine eigene, registrierte
 * MCP-Sitzung — gemeinsamer Weg von `handleDevicePoll` (Device-Code-Login)
 * und den API-Keys (`apiKeys.ts`).
 *
 * generateLink + sofortiges serverseitiges verifyOtp erzeugt eine neue,
 * unabhängige Supabase-Sitzung ohne Mail-Versand und ohne geteiltes
 * Refresh-Token. `userId` stammt nie aus einer Anfrage, sondern aus einer
 * Zeile, deren user_id die Datenbank selbst gesetzt hat (Device-Grant:
 * `auth.uid()` der Web-App; API-Key: `create_mcp_api_key`).
 *
 * Die Sitzung ist aal1 (nur Magic Link) — sobald der Owner einen zweiten
 * Faktor hat, sähe sie im CRM nichts. Deshalb wird sie gleich danach über
 * `register_mcp_session` (nur service_role) als MCP-Sitzung registriert
 * (Migration 20261107005700_owner_mfa.sql). **Fail closed:** scheitert das,
 * wird die frische Sitzung abgemeldet und nichts zurückgegeben — eine nicht
 * registrierte Sitzung wäre eine Verbindung, die in Settings → Security fehlt
 * und sich nicht widerrufen lässt.
 */
export async function mintRegisteredSession(
  deps: MintDeps,
  userId: string,
  clientName: string | null
): Promise<MintResult> {
  const { data: targetUser, error: targetUserError } = await deps.admin.auth.admin.getUserById(userId);
  if (targetUserError || !targetUser.user?.email) return { ok: false, reason: "user" };

  const { data: link, error: linkError } = await deps.admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetUser.user.email,
  });
  if (linkError || !link?.properties?.hashed_token) return { ok: false, reason: "link" };

  const { data: verified, error: verifyError } = await deps.anon().auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || !verified.session) return { ok: false, reason: "verify" };

  const sessionId = accessTokenClaims(verified.session.access_token)?.session_id;
  const { error: registerError } = sessionId
    ? await deps.admin.rpc("register_mcp_session", {
        p_session_id: sessionId,
        p_user_id: targetUser.user.id,
        p_client_name: clientName,
      })
    : { error: new Error("access token without session_id") };
  if (registerError || !sessionId) {
    console.error("register_mcp_session failed", registerError);
    // Die Sitzung nicht verwaist liegen lassen.
    await deps.admin.auth.admin.signOut(verified.session.access_token, "local").catch(() => undefined);
    return { ok: false, reason: "register" };
  }

  return {
    ok: true,
    sessionId,
    session: {
      sub: targetUser.user.id,
      at: verified.session.access_token,
      rt: verified.session.refresh_token,
    },
  };
}
