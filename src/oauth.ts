import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

/**
 * Trägt die OAuth-Parameter (client_id, code_challenge, redirect_uri, state)
 * über den Umweg durch die Mailbox des Nutzers — der Server ist zustandslos,
 * also müssen sie in der `emailRedirectTo`-URL des Magic-Links mitreisen statt
 * in einer Session/Tabelle zu warten. Kurze Lebensdauer, weil sie ab dem
 * Mailversand nutzlos werden, sobald der Nutzer nicht rechtzeitig klickt.
 */
interface PendingPayload { t: "pending"; c: string; ch: string; r: string; s?: string; exp: number }

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
    const payload = JSON.stringify({
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
    const clientId = hmacSign(payload);
    return { ...JSON.parse(payload) as Omit<OAuthClientInformationFull, "client_id">, client_id: clientId };
  },

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const data = hmacVerify(clientId);
    if (!data) return undefined;
    try {
      return { ...(JSON.parse(data) as Omit<OAuthClientInformationFull, "client_id">), client_id: clientId };
    } catch {
      return undefined;
    }
  },
};

// ─── Anmeldeseite ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PAGE_STYLE = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    h1{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}
    .sub{color:#666;font-size:.875rem;margin-bottom:1.5rem;line-height:1.5}
    .client{font-weight:600;color:#111}
    label{display:block;font-size:.85rem;font-weight:500;margin-bottom:.4rem;color:#333}
    input[type=email]{width:100%;padding:.7rem 1rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;outline:none;transition:border .2s}
    input:focus{border-color:#2563eb}
    .field{margin-bottom:1rem}
    .error{color:#dc2626;font-size:.85rem;margin-bottom:1rem;padding:.6rem;background:#fef2f2;border-radius:6px}
    button{width:100%;margin-top:.5rem;padding:.8rem;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:500;cursor:pointer;transition:background .2s}
    button:hover{background:#1d4ed8}
    .note{margin-top:1.2rem;font-size:.78rem;color:#999;text-align:center}
`;

function authPage(opts: {
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  state?: string;
  email?: string;
  error?: string;
}): string {
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
    <p class="sub"><span class="client">${esc(opts.clientName ?? "Claude")}</span> möchte auf dein CRM zugreifen und Kontakte, Deals und Aufgaben verwalten. Melde dich per Magic-Link an — kein Passwort nötig, der Zugriff gilt genau für deinen Account und deine Organisation.</p>
    ${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
    <form method="POST">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="code_challenge_method" value="S256">
      <input type="hidden" name="redirect_uri" value="${esc(opts.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${esc(opts.codeChallenge)}">
      <input type="hidden" name="client_id" value="${encodeURIComponent(opts.clientId)}">
      <input type="hidden" name="state" value="${esc(opts.state ?? "")}">
      <div class="field">
        <label for="email">E-Mail</label>
        <input type="email" id="email" name="email" value="${esc(opts.email ?? "")}" autocomplete="username" autofocus required>
      </div>
      <button type="submit">Magic-Link senden</button>
    </form>
    <p class="note">Der Zugang endet, sobald dein CRM-Konto deaktiviert wird.</p>
  </div>
</body>
</html>`;
}

function checkEmailPage(email: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jan CRM – Postfach prüfen</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Postfach prüfen</h1>
    <p class="sub">Falls <span class="client">${esc(email)}</span> ein CRM-Konto hat, ist gerade ein Anmeldelink unterwegs. Öffne ihn in diesem Browser, um die Anmeldung abzuschließen.</p>
    <p class="note">Der Link ist 10 Minuten gültig und nur einmal verwendbar.</p>
  </div>
</body>
</html>`;
}

/**
 * Rückkehrseite des Magic-Links. Supabase hängt die Session als URL-**Fragment**
 * an (`#access_token=...`), das der Server nie zu sehen bekommt — ein kurzes
 * Inline-Skript liest es aus und reicht es zusammen mit dem `p`-Parameter
 * (den ausstehenden OAuth-Parametern, siehe `PendingPayload`) an
 * `/auth/magic-complete` weiter, das den eigentlichen OAuth-Code ausstellt.
 */
export function magicCallbackPage(): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jan CRM – Anmeldung</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Anmeldung wird abgeschlossen …</h1>
    <p class="sub" id="msg">Einen Moment bitte.</p>
  </div>
  <script>
    (function () {
      var hash = new URLSearchParams(window.location.hash.slice(1));
      var access_token = hash.get("access_token");
      var refresh_token = hash.get("refresh_token");
      var p = new URLSearchParams(window.location.search).get("p");
      var msg = document.getElementById("msg");

      function fail(text) { msg.textContent = text; }

      if (!access_token || !refresh_token || !p) {
        fail("Der Link ist ungültig oder abgelaufen. Bitte fordere in Claude einen neuen an.");
        return;
      }

      fetch("/auth/magic-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: access_token, refresh_token: refresh_token, p: p }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.redirect) {
            window.location.href = data.redirect;
          } else {
            fail(data.error || "Anmeldung fehlgeschlagen. Bitte fordere einen neuen Link an.");
          }
        })
        .catch(function () {
          fail("Anmeldung fehlgeschlagen. Bitte fordere einen neuen Link an.");
        });
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
    // Access the underlying Express request (res.req is set by Express internally)
    const req = (res as unknown as {
      req: { method: string; body: Record<string, string>; query: Record<string, string> };
    }).req;

    // state may come from params (GET flow) or from the POST body (form re-submission).
    // Always prefer params.state, fall back to what was POSTed or queried.
    const state: string | undefined =
      params.state ?? req.body?.state ?? req.query?.state ?? undefined;

    const page = (error?: string, email?: string) =>
      authPage({
        clientName: client.client_name,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        clientId: client.client_id,
        state,
        email,
        error,
      });

    if (req.method !== "POST") {
      res.send(page());
      return;
    }

    const email = String(req.body?.email ?? "").trim();
    if (!email) {
      res.status(200).send(page("Bitte gib deine E-Mail-Adresse ein.", email));
      return;
    }

    const pending: PendingPayload = {
      t: "pending",
      c: client.client_id,
      ch: params.codeChallenge,
      r: params.redirectUri,
      s: state,
      exp: Date.now() + 10 * 60 * 1000,
    };
    const redirectTo = `${ISSUER_URL.toString().replace(/\/$/, "")}/auth/magic-callback?p=${encodeURIComponent(seal(pending))}`;

    // Fehler von signInWithOtp wird bewusst nicht unterschieden — dieselbe
    // "Postfach prüfen"-Seite für existierende wie für unbekannte Adressen,
    // sonst wird das Formular zum Account-Enumeration-Orakel (wie im
    // CRM-Web-Login, CLAUDE.md Leitplanke 7).
    await anonClient().auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    res.status(200).send(checkEmailPage(email));
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
 * Nimmt die per Magic-Link erhaltene Supabase-Session entgegen (aus dem
 * URL-Fragment, das `magicCallbackPage()`s Inline-Skript ausgelesen hat) und
 * schließt damit den ursprünglichen OAuth-`authorize()`-Aufruf ab — exakt
 * derselbe letzte Schritt wie am Ende des früheren Passwort-Pfads
 * (`issueAuthCode` + Redirect mit `?code=`), nur von hier statt von dort aus.
 */
export async function handleMagicComplete(req: Request, res: Response): Promise<void> {
  const { access_token, refresh_token, p } = (req.body ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    p?: string;
  };

  if (!access_token || !refresh_token || !p) {
    res.status(400).json({ error: "Anmeldung ist unvollständig. Bitte erneut versuchen." });
    return;
  }

  const pending = open<PendingPayload>(p);
  if (!pending || pending.t !== "pending") {
    res.status(400).json({ error: "Anmeldung ist ungültig. Bitte fordere einen neuen Link an." });
    return;
  }
  if (Date.now() > pending.exp) {
    res.status(400).json({ error: "Anmeldung ist abgelaufen. Bitte fordere einen neuen Link an." });
    return;
  }

  // Bestätigt, dass der Access-Token echt und aktuell ist — Supabase prüft
  // Signatur und Ablauf serverseitig, statt dass wir dem Client blind glauben.
  const { data, error } = await userClient(access_token).auth.getUser();
  if (error || !data.user) {
    res.status(401).json({ error: "Sitzung ist ungültig. Bitte fordere einen neuen Link an." });
    return;
  }

  const session: Session = { sub: data.user.id, at: access_token, rt: refresh_token };
  const code = issueAuthCode(pending.c, pending.ch, pending.r, session);
  const url = new URL(pending.r);
  url.searchParams.set("code", code);
  if (pending.s) url.searchParams.set("state", pending.s);
  res.json({ redirect: url.toString() });
}
