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

// ─── Redirect-URI-Allowlist ──────────────────────────────────────────────────
//
// Die Dynamic Client Registration steht offen — jeder darf sich einen Client
// anlegen. Ohne Schranke darf er dabei auch `redirect_uri` frei wählen, und
// dann genügt es, den Magic-Link auf eine fremde Adresse ausstellen zu lassen:
// klickt der Nutzer, landet der fertige OAuth-Code beim Angreifer. Deshalb
// hier eine feste Liste — der Connector bedient realistisch nur Claude plus
// lokal laufende Clients.
//
// Geprüft wird an drei Stellen: bei der Registrierung, beim Nachschlagen des
// Clients (damit früher ausgestellte client_ids nicht weitergelten) und noch
// einmal, bevor der Code tatsächlich ausgeliefert wird.

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

// ─── Browser-Bindung des Magic-Links ─────────────────────────────────────────
//
// Der Link darf nur in dem Browser etwas bewirken, in dem die Anmeldung
// gestartet wurde. Sonst kann jeder einen Anmeldelink an eine fremde Adresse
// auslösen und hoffen, dass geklickt wird. Beim Absenden des Formulars geht
// ein Zufallswert als Cookie an den Browser, dessen Hash im versiegelten
// `p`-Payload mitreist; beim Abschluss müssen beide zusammenpassen.

const LOGIN_COOKIE = "mcp_login";
const LOGIN_COOKIE_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
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

/**
 * Trägt die OAuth-Parameter (client_id, code_challenge, redirect_uri, state)
 * über den Umweg durch die Mailbox des Nutzers — der Server ist zustandslos,
 * also müssen sie in der `emailRedirectTo`-URL des Magic-Links mitreisen statt
 * in einer Session/Tabelle zu warten. Kurze Lebensdauer, weil sie ab dem
 * Mailversand nutzlos werden, sobald der Nutzer nicht rechtzeitig klickt.
 */
interface PendingPayload {
  t: "pending";
  c: string;
  ch: string;
  r: string;
  s?: string;
  /** SHA-256 des Login-Cookies — bindet den Link an den startenden Browser. */
  n: string;
  exp: number;
}

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
    .target{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:.75rem 1rem;font-size:.85rem;color:#333;margin-bottom:1rem;word-break:break-all}
    .target b{display:block;font-size:.72rem;font-weight:600;color:#777;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem}
    button[disabled]{background:#93b4f5;cursor:default}
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
    <p class="sub"><span class="client">${esc(opts.clientName ?? "Claude")}</span> möchte auf dein CRM zugreifen und Kontakte, Projekte und Aufgaben verwalten. Melde dich per Magic-Link an — kein Passwort nötig, der Zugriff gilt genau für deinen Account und deine Organisation.</p>
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
    <p class="sub">Falls <span class="client">${esc(email)}</span> ein CRM-Konto hat, ist gerade ein Anmeldelink unterwegs. Öffne ihn <b>in diesem Browser</b> — anderswo funktioniert er nicht, das schützt dein Konto davor, dass jemand anders die Anmeldung für dich anstößt.</p>
    <p class="note">Der Link ist 10 Minuten gültig und nur einmal verwendbar.</p>
  </div>
</body>
</html>`;
}

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

/**
 * Rückkehrseite des Magic-Links. Supabase hängt die Session als URL-**Fragment**
 * an (`#access_token=...`), das der Server nie zu sehen bekommt — ein kurzes
 * Inline-Skript liest es aus und reicht es zusammen mit dem `p`-Parameter
 * (den ausstehenden OAuth-Parametern, siehe `PendingPayload`) an
 * `/auth/magic-complete` weiter, das den eigentlichen OAuth-Code ausstellt.
 *
 * Bewusst **kein** automatischer Abschluss: wohin der Code danach geht, steht
 * im `p`-Parameter, und den hat nicht zwingend der Nutzer selbst erzeugt. Wer
 * hier landet, ohne in Claude eine Verbindung gestartet zu haben, soll das
 * sehen können, bevor irgendetwas ausgestellt wird — deshalb rendert der
 * Server Client und Ziel-Host in die Seite und wartet auf einen Klick.
 */
export function magicCallbackPage(p: string): string {
  const pending = p ? open<PendingPayload>(p) : null;
  if (!pending || pending.t !== "pending" || Date.now() > pending.exp || !redirectUriAllowed(pending.r)) {
    return noticePage(
      "Anmeldung",
      "Der Link ist ungültig oder abgelaufen. Bitte fordere in Claude einen neuen an."
    );
  }

  const clientName = decodeClient(pending.c)?.client_name ?? "Claude";
  const targetHost = new URL(pending.r).host;

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
    <h1>Zugriff bestätigen</h1>
    <p class="sub">Du bist angemeldet. <span class="client">${esc(clientName)}</span> erhält damit Zugriff auf dein CRM — Kontakte, Projekte, Aufgaben, Dokumente und Kalender.</p>
    <div class="target"><b>Weiterleitung an</b>${esc(targetHost)}</div>
    <p class="sub" id="msg">Hast du diese Verbindung nicht selbst in Claude gestartet, schließe diese Seite einfach.</p>
    <button type="button" id="go">Zugriff erlauben</button>
  </div>
  <script>
    (function () {
      var hash = new URLSearchParams(window.location.hash.slice(1));
      var access_token = hash.get("access_token");
      var refresh_token = hash.get("refresh_token");
      var p = new URLSearchParams(window.location.search).get("p");
      var msg = document.getElementById("msg");
      var btn = document.getElementById("go");

      function fail(text) { msg.textContent = text; btn.disabled = true; }

      if (!access_token || !refresh_token || !p) {
        fail("Der Link ist ungültig oder abgelaufen. Bitte fordere in Claude einen neuen an.");
        return;
      }

      btn.addEventListener("click", function () {
        btn.disabled = true;
        msg.textContent = "Anmeldung wird abgeschlossen …";

        fetch("/auth/magic-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
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

    // Zweite Schranke neben der Allowlist bei der Registrierung: hier steht die
    // URL, die tatsächlich im Magic-Link mitreist.
    if (!redirectUriAllowed(params.redirectUri)) {
      res.status(400).send(page("Dieser Client ist für diesen Server nicht zugelassen."));
      return;
    }

    // Bindet den gleich versendeten Link an genau diesen Browser: der Klartext
    // geht als HttpOnly-Cookie an den Nutzer, nur sein Hash reist im Link mit.
    const nonce = randomBytes(32).toString("base64url");
    res.cookie(LOGIN_COOKIE, nonce, {
      httpOnly: true,
      secure: ISSUER_URL.protocol === "https:",
      sameSite: "lax", // der Klick kommt als Top-Level-Navigation aus der Mail
      path: "/",
      maxAge: LOGIN_COOKIE_TTL_MS,
    });

    const pending: PendingPayload = {
      t: "pending",
      c: client.client_id,
      ch: params.codeChallenge,
      r: params.redirectUri,
      s: state,
      n: sha256(nonce).toString("base64url"),
      exp: Date.now() + LOGIN_COOKIE_TTL_MS,
    };
    const redirectTo = `${ISSUER_URL.toString().replace(/\/$/, "")}/auth/magic-callback?p=${encodeURIComponent(seal(pending))}`;

    // Fehler von signInWithOtp wird bewusst nicht unterschieden — dieselbe
    // "Postfach prüfen"-Seite für existierende wie für unbekannte Adressen,
    // sonst wird das Formular zum Account-Enumeration-Orakel (wie im
    // CRM-Web-Login, CLAUDE.md Leitplanke 7).
    //
    // `shouldCreateUser: false` ist dabei entscheidend: der Default legt für
    // jede unbekannte Adresse ein Supabase-Konto an — dieses Formular steht
    // offen im Netz und wäre damit sowohl eine Konto-Fabrik als auch ein
    // Mail-Versender für beliebige Empfänger. Anmelden darf sich hier nur, wer
    // im CRM schon existiert; die Antwortseite bleibt für beide Fälle gleich.
    await anonClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
    });
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

  // Letzte Schranke vor dem Ausstellen: das Ziel muss immer noch zugelassen
  // sein. Ein `p`, das vor der Allowlist versiegelt wurde, trägt sonst eine
  // fremde redirect_uri unbemerkt bis hierher.
  if (!redirectUriAllowed(pending.r)) {
    res.status(400).json({ error: "Dieser Client ist für diesen Server nicht zugelassen." });
    return;
  }

  // Der Link gilt nur in dem Browser, in dem die Anmeldung gestartet wurde.
  // Ohne diese Prüfung genügt es, einen Anmeldelink an eine fremde Adresse
  // auslösen zu lassen und auf den Klick zu warten — der fertige OAuth-Code
  // ginge dann an den, der den Flow gestartet hat.
  const nonce = readCookie(req.headers.cookie, LOGIN_COOKIE);
  const expected = Buffer.from(pending.n, "base64url");
  const actual = nonce ? sha256(nonce) : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(400).json({
      error:
        "Dieser Anmeldelink gehört zu einem anderen Browser. Öffne ihn dort, " +
        "wo du die Anmeldung gestartet hast, oder fordere in Claude einen neuen Link an.",
    });
    return;
  }

  // Bestätigt, dass der Access-Token echt und aktuell ist — Supabase prüft
  // Signatur und Ablauf serverseitig, statt dass wir dem Client blind glauben.
  const { data, error } = await userClient(access_token).auth.getUser();
  if (error || !data.user) {
    res.status(401).json({ error: "Sitzung ist ungültig. Bitte fordere einen neuen Link an." });
    return;
  }

  // Einmal verwendet, ist die Bindung verbraucht.
  res.clearCookie(LOGIN_COOKIE, { path: "/" });

  const session: Session = { sub: data.user.id, at: access_token, rt: refresh_token };
  const code = issueAuthCode(pending.c, pending.ch, pending.r, session);
  const url = new URL(pending.r);
  url.searchParams.set("code", code);
  if (pending.s) url.searchParams.set("state", pending.s);
  res.json({ redirect: url.toString() });
}
