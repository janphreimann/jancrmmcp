import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { anonClient, userClient } from "./supabase.js";
import { ISSUER_URL } from "./issuer.js";

// ─── Token-Format ────────────────────────────────────────────────────────────
//
// Der Server hält keinen Zustand (Vercel, stateless) — alles, was er über eine
// Sitzung weiß, steckt im Token selbst. Weil darin die Supabase-Sitzung des
// Nutzers liegt (Access- und Refresh-Token), werden die Nutzlasten
// *verschlüsselt* und nicht nur signiert: wer ein MCP-Token in die Hand
// bekommt, soll daraus keine CRM-Sitzung herauslösen können. AES-256-GCM ist
// zugleich authentifiziert, ersetzt die Signatur also mit.
//
// Die Client-Metadaten der Dynamic Client Registration sind dagegen öffentlich
// und bleiben HMAC-signiert — sie stehen als client_id in jeder Anfrage.

function keyMaterial(): Buffer {
  if (!process.env.MCP_API_KEY) throw new Error("MCP_API_KEY must be set");
  return createHash("sha256").update(process.env.MCP_API_KEY).digest();
}

function seal(payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open<T>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function hmacSign(data: string): string {
  const sig = createHmac("sha256", keyMaterial()).update(data).digest("base64url");
  return `${Buffer.from(data).toString("base64url")}.${sig}`;
}

function hmacVerify(token: string): string | null {
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return null;
  const data = Buffer.from(token.slice(0, lastDot), "base64url").toString();
  const sigExpected = createHmac("sha256", keyMaterial()).update(data).digest("base64url");
  try {
    const a = Buffer.from(token.slice(lastDot + 1), "base64url");
    const b = Buffer.from(sigExpected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return data;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ─── Redirect-URI-Allowlist ──────────────────────────────────────────────────
//
// Die Dynamic Client Registration steht offen — jeder darf sich einen Client
// anlegen. Ohne Schranke darf er dabei auch `redirect_uri` frei wählen, und
// dann würde der fertige Autorisierungscode an eine fremde Adresse gehen.
// Deshalb hier eine feste Liste — der Connector bedient realistisch nur
// Claude plus lokal laufende Clients.
//
// Geprüft wird an drei Stellen: bei der Registrierung, beim Nachschlagen des
// Clients (damit früher ausgestellte client_ids nicht weitergelten) und noch
// einmal vor jedem Ausstellen eines Codes.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const ALLOWED_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  ...(process.env.MCP_ALLOWED_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);

export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // Lokale Clients (Claude Desktop, MCP-Inspector) bekommen vom OS einen
  // beliebigen Port — Host prüfen genügt, http ist hier unbedenklich.
  if (LOOPBACK_HOSTS.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:") return false;
  return ALLOWED_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
}

/** Client-Metadaten aus dem signierten client_id zurücklesen. */
function decodeClient(clientId: string): OAuthClientInformationFull | undefined {
  const data = hmacVerify(clientId);
  if (!data) return undefined;
  try {
    return { ...(JSON.parse(data) as Omit<OAuthClientInformationFull, "client_id">), client_id: clientId };
  } catch {
    return undefined;
  }
}

// ─── Nutzlasten ──────────────────────────────────────────────────────────────

/** Supabase-Sitzung des angemeldeten Nutzers. */
interface Session {
  sub: string;   // Supabase-User-ID
  at: string;    // Access-Token (JWT, ~1 h)
  rt: string;    // Refresh-Token
}

interface CodePayload extends Session { t: "code"; c: string; ch: string; r: string; exp: number }
interface AccessPayload extends Session { t: "token"; c: string; exp: number }
interface RefreshPayload { t: "refresh"; c: string; sub: string; rt: string; exp: number }

const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 Tage

/**
 * Laufzeit des Supabase-Access-Tokens aus dessen eigenem `exp` — das MCP-Token
 * soll keine Sekunde länger gelten als die CRM-Sitzung, die darin steckt.
 */
function accessTokenExpiry(supabaseAccessToken: string): number {
  try {
    const claims = JSON.parse(
      Buffer.from(supabaseAccessToken.split(".")[1], "base64url").toString()
    ) as { exp?: number };
    if (claims.exp) return claims.exp;
  } catch { /* fällt unten auf den Standard zurück */ }
  return Math.floor(Date.now() / 1000) + 3600;
}

function issueAuthCode(clientId: string, codeChallenge: string, redirectUri: string, s: Session): string {
  return seal({
    t: "code", c: clientId, ch: codeChallenge, r: redirectUri,
    exp: Date.now() + 5 * 60 * 1000, ...s,
  } satisfies CodePayload);
}

function issueTokens(clientId: string, s: Session): OAuthTokens {
  const exp = accessTokenExpiry(s.at);
  return {
    access_token: seal({ t: "token", c: clientId, exp, ...s } satisfies AccessPayload),
    token_type: "Bearer",
    expires_in: Math.max(60, exp - Math.floor(Date.now() / 1000)),
    refresh_token: seal({
      t: "refresh", c: clientId, sub: s.sub, rt: s.rt,
      exp: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL,
    } satisfies RefreshPayload),
  };
}

// ─── Stateless client store (client info encoded into client_id) ──────────────

const clientsStore: OAuthRegisteredClientsStore = {
  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const uris = client.redirect_uris ?? [];
    if (uris.length === 0) {
      throw new InvalidClientMetadataError("At least one redirect_uri is required");
    }
    const rejected = uris.filter((uri) => !redirectUriAllowed(uri));
    if (rejected.length > 0) {
      throw new InvalidClientMetadataError(
        `redirect_uri not permitted for this server: ${rejected.join(", ")}`
      );
    }

    const payload = JSON.stringify({
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
    const clientId = hmacSign(payload);
    return { ...JSON.parse(payload) as Omit<OAuthClientInformationFull, "client_id">, client_id: clientId };
  },

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const client = decodeClient(clientId);
    if (!client) return undefined;
    // Auch hier prüfen, nicht nur bei der Registrierung: client_ids sind
    // signierte Blobs ohne Ablauf, ein vor der Allowlist ausgestellter bliebe
    // sonst für immer gültig.
    if (!(client.redirect_uris ?? []).every(redirectUriAllowed)) return undefined;
    return client;
  },
};

// ─── Anmeldeseite ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CRM_APP_URL = process.env.CRM_APP_URL ?? "https://janreimanncrm.vercel.app";

const PAGE_STYLE = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    h1{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}
    .sub{color:#666;font-size:.875rem;margin-bottom:1.5rem;line-height:1.5}
    .client{font-weight:600;color:#111}
    .note{margin-top:1.2rem;font-size:.78rem;color:#999;text-align:center}
    .code{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:1rem;font-size:1.8rem;font-weight:700;letter-spacing:.12em;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;margin-bottom:1.2rem}
    .steps{font-size:.85rem;color:#333;line-height:1.7;margin-bottom:.5rem;padding-left:1.1rem}
    .status{font-size:.85rem;color:#666;text-align:center;margin-top:1rem}
    a{color:#2563eb}
`;

function noticePage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jan CRM – ${esc(title)}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(message)}</p>
  </div>
</body>
</html>`;
}

/** Vierstellig gruppiert, leichter abzutippen/vorzulesen: "ABCD1234" → "ABCD-1234". */
function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Zeigt den Pairing-Code und pollt im Hintergrund, bis er in der CRM-Web-App
 * eingelöst wurde. Ersetzt den früheren Magic-Link-Login (siehe Kommentar an
 * `../janreimanncrm/supabase/migrations/20261104000400_mcp_device_grants.sql`):
 * Mail-Clients öffnen Links regelmäßig in einem anderen Browser-Kontext als
 * dem, in dem die Anmeldung gestartet wurde, was die frühere Cookie-Bindung
 * fälschlich als Fehler auslöste. Der Device-Code braucht keinen bestimmten
 * Browser — der Code funktioniert überall, wo der Nutzer ohnehin schon in
 * seinem CRM angemeldet ist.
 */
function devicePendingPage(opts: { clientName?: string; code: string; secret: string }): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jan CRM – Zugriff erlauben</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Zugriff erlauben</h1>
    <p class="sub"><span class="client">${esc(opts.clientName ?? "Claude")}</span> möchte auf dein CRM zugreifen und Kontakte, Projekte und Aufgaben verwalten.</p>
    <div class="code">${esc(formatCode(opts.code))}</div>
    <ol class="steps">
      <li>Öffne dein CRM (${esc(new URL(CRM_APP_URL).host)}) — auf jedem Gerät, du bist dort schon angemeldet.</li>
      <li>Gehe zu Einstellungen → Integrationen → Verbundene Apps.</li>
      <li>Gib den obigen Code ein und bestätige.</li>
    </ol>
    <p class="status" id="status">Warte auf Bestätigung …</p>
    <p class="note">Der Code ist 10 Minuten gültig und nur einmal verwendbar.</p>
  </div>
  <script>
    (function () {
      var secret = ${JSON.stringify(opts.secret)};
      var status = document.getElementById("status");
      var stopped = false;

      function poll() {
        if (stopped) return;
        fetch("/auth/device-poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: secret }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.status === "claimed" && data.redirect) {
              stopped = true;
              status.textContent = "Bestätigt — Verbindung wird hergestellt …";
              window.location.href = data.redirect;
            } else if (data.status === "expired") {
              stopped = true;
              status.textContent = "Der Code ist abgelaufen. Bitte fordere in Claude eine neue Verbindung an.";
            } else {
              setTimeout(poll, 2000);
            }
          })
          .catch(function () { setTimeout(poll, 3000); });
      }

      poll();
    })();
  </script>
</body>
</html>`;
}

// ─── OAuth Provider ───────────────────────────────────────────────────────────

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (!redirectUriAllowed(params.redirectUri)) {
      res.status(400).send(noticePage("Nicht zugelassen", "Dieser Client ist für diesen Server nicht zugelassen."));
      return;
    }

    // Das Geheimnis bleibt ausschließlich auf dieser Seite (im Inline-Skript
    // fürs Polling) — der Server behält nur dessen Hash. Wer den `code` kennt
    // (Bildschirm/Ohr), kann damit noch keine Tokens abholen; wer das
    // `secret` kennt, wartet bereits hier.
    const secret = randomBytes(32).toString("base64url");

    const { data, error } = await anonClient().rpc("create_mcp_device_grant", {
      p_secret_hash: sha256Hex(secret),
      p_client_id: client.client_id,
      p_code_challenge: params.codeChallenge,
      p_redirect_uri: params.redirectUri,
      p_state: params.state ?? null,
    });

    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.code) {
      res.status(502).send(noticePage("Fehler", "Verbindung konnte nicht gestartet werden. Bitte versuche es in Claude erneut."));
      return;
    }

    res.type("html").set("Cache-Control", "no-store").send(
      devicePendingPage({ clientName: client.client_name, code: row.code, secret })
    );
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const parsed = open<CodePayload>(authorizationCode);
    if (!parsed || parsed.t !== "code") throw new Error("Invalid authorization code");
    if (Date.now() > parsed.exp) throw new Error("Authorization code expired");
    return parsed.ch;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const parsed = open<CodePayload>(authorizationCode);
    if (!parsed || parsed.t !== "code") throw new Error("Invalid authorization code");
    if (Date.now() > parsed.exp) throw new Error("Authorization code expired");
    if (parsed.c !== client.client_id) throw new Error("client_id mismatch");
    return issueTokens(client.client_id, { sub: parsed.sub, at: parsed.at, rt: parsed.rt });
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const parsed = open<RefreshPayload>(refreshToken);
    if (!parsed || parsed.t !== "refresh") throw new Error("Invalid refresh token");
    if (Math.floor(Date.now() / 1000) > parsed.exp) throw new Error("Refresh token expired");
    if (parsed.c !== client.client_id) throw new Error("client_id mismatch");

    // Die eigentliche Prüfung macht Supabase: ist das Konto deaktiviert oder
    // die Sitzung abgemeldet, scheitert der Tausch — und damit endet auch der
    // MCP-Zugang, ohne dass wir hier eine Sperrliste führen müssten.
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: parsed.rt });
    if (error || !data.session || !data.user) {
      throw new Error("Session is no longer valid — please reconnect");
    }

    return issueTokens(client.client_id, {
      sub: data.user.id,
      at: data.session.access_token,
      rt: data.session.refresh_token,
    });
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const parsed = open<AccessPayload>(token);
    if (!parsed || parsed.t !== "token") throw new Error("Invalid access token");
    if (Math.floor(Date.now() / 1000) > parsed.exp) throw new Error("Access token expired");
    return {
      token,
      clientId: parsed.c,
      scopes: [],
      expiresAt: parsed.exp,
      // Hieraus baut index.ts den Ctx — ab hier spricht jede Abfrage als dieser
      // Nutzer, und die RLS des CRM erledigt die Mandantentrennung.
      extra: { sub: parsed.sub, supabaseAccessToken: parsed.at },
    };
  },
};

/**
 * Wird von der Polling-Seite (`devicePendingPage`s Inline-Skript) alle paar
 * Sekunden aufgerufen, bis die CRM-Web-App den Code eingelöst hat (siehe
 * `claim_mcp_device_grant` in der Migration). Sobald `poll_mcp_device_grant`
 * `claimed` mit Access-/Refresh-Token liefert, ist das exakt der letzte
 * Schritt des früheren Passwort- bzw. Magic-Link-Pfads (`issueAuthCode` +
 * Redirect mit `?code=`), nur von hier aus statt von dort.
 */
export async function handleDevicePoll(req: Request, res: Response): Promise<void> {
  const { secret } = (req.body ?? {}) as { secret?: string };
  if (!secret) {
    res.status(400).json({ status: "expired" });
    return;
  }

  const { data, error } = await anonClient().rpc("poll_mcp_device_grant", { p_secret: secret });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row || row.status === "expired") {
    res.json({ status: "expired" });
    return;
  }
  if (row.status === "pending") {
    res.json({ status: "pending" });
    return;
  }

  // status === "claimed": die Zeile ist mit dem Lesen bereits gelöscht
  // (Einmalverwendung, siehe Migration) — ab hier kein zweiter Versuch mehr.
  if (!row.access_token || !row.refresh_token || !row.redirect_uri || !row.code_challenge || !row.client_id) {
    res.json({ status: "expired" });
    return;
  }

  // Letzte Schranke vor dem Ausstellen: das Ziel muss immer noch zugelassen
  // sein. Eine Anfrage, die vor der Allowlist gestellt wurde, trägt sonst eine
  // fremde redirect_uri unbemerkt bis hierher.
  if (!redirectUriAllowed(row.redirect_uri)) {
    res.status(400).json({ status: "expired", error: "Dieser Client ist für diesen Server nicht zugelassen." });
    return;
  }

  // Bestätigt, dass der Access-Token echt und aktuell ist — Supabase prüft
  // Signatur und Ablauf serverseitig, statt dass wir der Datenbankzeile blind
  // glauben.
  const { data: userData, error: userError } = await userClient(row.access_token).auth.getUser();
  if (userError || !userData.user) {
    res.status(401).json({ status: "expired", error: "Sitzung ist ungültig. Bitte fordere einen neuen Code an." });
    return;
  }

  const session: Session = { sub: userData.user.id, at: row.access_token, rt: row.refresh_token };
  const code = issueAuthCode(row.client_id, row.code_challenge, row.redirect_uri, session);
  const url = new URL(row.redirect_uri);
  url.searchParams.set("code", code);
  if (row.state) url.searchParams.set("state", row.state);
  res.json({ status: "claimed", redirect: url.toString() });
}
