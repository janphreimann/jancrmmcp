import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { open, seal, sha256Hex } from "./seal.js";
import { accessTokenClaims, mintRegisteredSession, type MintDeps, type Session } from "./mcpSession.js";

// ─── Feste API-Keys (`jcrm_…`) ───────────────────────────────────────────────
//
// Claude Code erneuert MCP-OAuth-Tokens nicht; nach einer Stunde (Laufzeit des
// Supabase-JWT) wäre jede Verbindung tot. Ein API-Key ist deshalb ein fester
// Bearer, hinter dem dieser Server selbst eine registrierte Supabase-Sitzung
// hält und erneuert (Migration `20261107007700_mcp_api_keys.sql` im CRM-Repo).
//
// - Die Datenbank kennt nur `sha256(key)`; Access- und Refresh-Token liegen
//   versiegelt (seal.ts) in `private.mcp_api_keys.sealed_session`.
// - Läuft das Access-Token in < 120 s ab, erneuert genau eine Instanz
//   (Lease, `mcp_api_key_take_lease`): erst per Refresh, scheitert der (Token
//   wegrotiert, Sitzung gelöscht, MCP_API_KEY gewechselt), mit einer frisch
//   erzeugten, registrierten Sitzung (selbstheilend). Die anderen warten.
// - Pro Instanz ein kleiner Cache (bis Ablauf − 120 s, höchstens 1 min) —
//   ein Widerruf greift hier also spätestens nach einer Minute.
// - Unbekannter oder widerrufener Key → InvalidTokenError (401). Störungen
//   (Datenbank, Lease-Timeout, Mint gescheitert) → ApiKeyUnavailableError
//   (ServerError → 500), **nie 401**: ein 401 ließe Clients ihre
//   Zugangsdaten verwerfen oder einen OAuth-Login starten.
// - Key, Hash und Tokens landen nie in Logs oder Fehlermeldungen.

export const API_KEY_PREFIX = "jcrm_";

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** Vorübergehende Störung — kein Urteil über den Key. */
export class ApiKeyUnavailableError extends ServerError {}

const MIN_REMAINING_S = 120;
const CACHE_MAX_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const LEASE_S = 20;
const WAIT_STEP_MS = 500;
const WAIT_STEPS = 20; // 20 × 500 ms = 10 s
// Zeitgrenzen der Erneuerung: zusammen unter LEASE_S, damit keine zweite
// Instanz den Lease bekommt, während diese noch arbeitet.
const REFRESH_TIMEOUT_MS = 6_000;
const MINT_TIMEOUT_MS = 9_000;
// Unbekannte Keys kurz merken: jeder `Bearer jcrm_<Müll>` kostete sonst
// eine Datenbankabfrage.
const NEGATIVE_CACHE_MS = 30 * 1000;
const NEGATIVE_CACHE_MAX = 500;

class StepTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface KeyRow {
  id: string;
  user_id: string;
  label: string;
  session_id: string | null;
  sealed_session: string | null;
  access_expires_at: string | null;
}

/** Inhalt von `sealed_session` — an die Key-Zeile gebunden (`k`). */
interface SealedKeySession extends Session {
  t: "apikey";
  k: string;
}

/** Eine nutzbare Sitzung für einen Key. */
interface Usable {
  id: string;
  sub: string;
  at: string;
  exp: number; // Sekunden
}

export interface ApiKeyDeps extends MintDeps {
  /** Millisekunden, wie Date.now (Tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Zeitgrenzen der Erneuerung in ms (Tests). */
  refreshTimeoutMs?: number;
  mintTimeoutMs?: number;
}

export interface ApiKeyVerifier {
  verify(key: string): Promise<AuthInfo>;
}

function unavailable(): ApiKeyUnavailableError {
  return new ApiKeyUnavailableError("CRM session for this API key is temporarily unavailable — try again shortly");
}

function failed(step: string, error: { code?: string; message?: string } | null | undefined): never {
  console.error(`api key: ${step} failed`, error?.code ?? "", error?.message ?? "");
  throw unavailable();
}

export function createApiKeyVerifier(deps: ApiKeyDeps): ApiKeyVerifier {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { admin } = deps;

  const cache = new Map<string, { s: Usable; until: number }>();
  const unknown = new Map<string, number>();

  function rememberUnknown(hash: string): void {
    const t = now();
    if (unknown.size >= NEGATIVE_CACHE_MAX) {
      for (const [h, until] of unknown) if (until <= t) unknown.delete(h);
      if (unknown.size >= NEGATIVE_CACHE_MAX) unknown.clear();
    }
    unknown.set(hash, t + NEGATIVE_CACHE_MS);
  }
  const inflight = new Map<string, Promise<Usable>>();

  async function resolve(hash: string): Promise<KeyRow | null> {
    const { data, error } = await admin.rpc("mcp_api_key_resolve", { p_key_hash: hash });
    if (error) failed("resolve", error);
    const row = (Array.isArray(data) ? data[0] : data) as KeyRow | null | undefined;
    return row?.id && row.user_id ? row : null;
  }

  function opened(row: KeyRow): SealedKeySession | null {
    if (!row.sealed_session) return null;
    const s = open<SealedKeySession>(row.sealed_session);
    if (!s || s.t !== "apikey" || s.k !== row.id || s.sub !== row.user_id || !s.at || !s.rt) return null;
    return s;
  }

  function usable(row: KeyRow): Usable | null {
    const s = opened(row);
    if (!s) return null;
    const claims = accessTokenClaims(s.at);
    const exp = claims?.exp;
    if (!exp || exp - MIN_REMAINING_S <= now() / 1000) return null;
    // Gehört das Token nicht (mehr) zur Sitzung der Zeile — etwa weil die
    // Sitzung durch ein globales Abmelden gelöscht wurde (session_id → NULL) —,
    // ließe die Datenbank es trotz gültiger Signatur nicht mehr durch (kein
    // registriertes MCP-Token mehr → mfa_required). Dann sofort erneuern statt
    // bis zum Ablauf mit 403 zu laufen.
    if (!row.session_id || claims?.session_id !== row.session_id) return null;
    return { id: row.id, sub: s.sub, at: s.at, exp };
  }

  async function refresh(rt: string, userId: string): Promise<{ session: Session; sessionId: string } | null> {
    try {
      const { data, error } = await withTimeout(
        deps.anon().auth.refreshSession({ refresh_token: rt }),
        deps.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS,
      );
      if (error || !data.session || data.user?.id !== userId) return null;
      const sessionId = accessTokenClaims(data.session.access_token)?.session_id;
      if (!sessionId) return null;
      return {
        sessionId,
        session: { sub: userId, at: data.session.access_token, rt: data.session.refresh_token },
      };
    } catch {
      return null;
    }
  }

  /** Nur mit Lease: Refresh, sonst neue Sitzung; speichern; Lease freigeben, wenn nichts gespeichert wurde. */
  async function renew(hash: string, id: string): Promise<Usable> {
    let stored = false;
    try {
      // Nach dem Lease neu lesen: eine andere Instanz kann zwischen unserem
      // Lesen und dem Lease erneuert haben. Mit dem alten Refresh-Token
      // scheiterte der Refresh, und eine unnötige neue Sitzung würde die
      // gerade erneuerte (und anderswo gecachte) löschen.
      const row = await resolve(hash);
      if (!row || row.id !== id) throw new InvalidTokenError("Invalid API key");
      const fresh = usable(row);
      if (fresh) return fresh;

      const prev = opened(row);
      let next = prev ? await refresh(prev.rt, row.user_id) : null;
      let minted = false;
      if (!next) {
        const m = await withTimeout(
          mintRegisteredSession(deps, row.user_id, `API key: ${row.label}`),
          deps.mintTimeoutMs ?? MINT_TIMEOUT_MS,
        ).catch((e) => {
          if (e instanceof StepTimeout) failed("mint", { message: "timeout" });
          throw e;
        });
        if (!m.ok) failed("mint", { message: m.reason });
        next = { session: m.session, sessionId: m.sessionId };
        minted = true;
      }

      const exp = accessTokenClaims(next.session.at)?.exp;
      if (!exp) failed("renew", { message: "access token without exp" });
      const sealed = seal({ t: "apikey", k: row.id, ...next.session } satisfies SealedKeySession);
      const { error } = await admin.rpc("mcp_api_key_store_session", {
        p_id: row.id,
        p_session_id: next.sessionId,
        p_sealed: sealed,
        p_access_expires_at: new Date(exp * 1000).toISOString(),
      });
      if (error) {
        // Eine frisch erzeugte Sitzung, die nirgends steht, nicht liegen lassen.
        if (minted) await admin.auth.admin.signOut(next.session.at, "local").catch(() => undefined);
        failed("store_session", error);
      }
      stored = true; // store_session gibt den Lease selbst frei
      return { id: row.id, sub: next.session.sub, at: next.session.at, exp };
    } finally {
      if (!stored) {
        await Promise.resolve(admin.rpc("mcp_api_key_release_lease", { p_id: id })).catch(() => undefined);
      }
    }
  }

  /** Eine andere Instanz erneuert gerade — auf ihr Ergebnis warten. */
  async function waitForOther(hash: string): Promise<Usable> {
    for (let i = 0; i < WAIT_STEPS; i++) {
      await sleep(WAIT_STEP_MS);
      const row = await resolve(hash);
      if (!row) throw new InvalidTokenError("Invalid API key");
      const u = usable(row);
      if (u) return u;
    }
    console.error("api key: timed out waiting for another instance to renew the session");
    throw unavailable();
  }

  async function obtain(hash: string): Promise<Usable> {
    const row = await resolve(hash);
    if (!row) throw new InvalidTokenError("Invalid API key");
    const u = usable(row);
    if (u) return u;

    const { data: won, error } = await admin.rpc("mcp_api_key_take_lease", { p_id: row.id, p_seconds: LEASE_S });
    if (error) failed("take_lease", error);
    return won === true ? renew(hash, row.id) : waitForOther(hash);
  }

  function remember(hash: string, s: Usable): void {
    const t = now();
    if (cache.size >= CACHE_MAX_ENTRIES) {
      for (const [h, e] of cache) if (e.until <= t) cache.delete(h);
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    }
    const until = Math.min(s.exp * 1000 - MIN_REMAINING_S * 1000, t + CACHE_MAX_MS);
    if (until > t) cache.set(hash, { s, until });
  }

  return {
    async verify(key: string): Promise<AuthInfo> {
      const hash = sha256Hex(key);
      const miss = unknown.get(hash);
      if (miss !== undefined) {
        if (miss > now()) throw new InvalidTokenError("Invalid API key");
        unknown.delete(hash);
      }
      const hit = cache.get(hash);
      let s: Usable;
      if (hit && hit.until > now()) {
        s = hit.s;
      } else {
        cache.delete(hash);
        // Gleichzeitige Anfragen derselben Instanz teilen sich eine Auflösung.
        let p = inflight.get(hash);
        if (!p) {
          p = obtain(hash).finally(() => inflight.delete(hash));
          inflight.set(hash, p);
        }
        try {
          s = await p;
        } catch (err) {
          if (err instanceof InvalidTokenError) {
            rememberUnknown(hash);
            throw err;
          }
          if (err instanceof ServerError) throw err;
          // Unerwartetes (Netzwerk, Bibliothek) ist eine Störung, kein Urteil
          // über den Key. Nur der Typ ins Log.
          console.error("api key: verification failed", err instanceof Error ? err.name : typeof err);
          throw unavailable();
        }
        remember(hash, s);
      }
      return {
        token: key,
        clientId: `api-key:${s.id}`,
        scopes: [],
        expiresAt: s.exp,
        // Wie beim OAuth-Pfad: daraus baut index.ts den Ctx.
        extra: { sub: s.sub, supabaseAccessToken: s.at },
      };
    },
  };
}
