import { createHmac, timingSafeEqual } from "crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ─── HMAC signing (stateless tokens — no DB needed, works on Vercel) ─────────

function getSecret(): string {
  if (!process.env.MCP_API_KEY) throw new Error("MCP_API_KEY must be set");
  return process.env.MCP_API_KEY;
}

function hmacSign(data: string): string {
  const sig = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${Buffer.from(data).toString("base64url")}.${sig}`;
}

function hmacVerify(token: string): string | null {
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return null;
  const dataB64 = token.slice(0, lastDot);
  const sigGiven = token.slice(lastDot + 1);
  const data = Buffer.from(dataB64, "base64url").toString();
  const sigExpected = createHmac("sha256", getSecret()).update(data).digest("base64url");
  try {
    const a = Buffer.from(sigGiven, "base64url");
    const b = Buffer.from(sigExpected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return data;
}

function issueAuthCode(clientId: string, codeChallenge: string, redirectUri: string): string {
  return hmacSign(
    JSON.stringify({
      t: "code",
      c: clientId,
      ch: codeChallenge,
      r: redirectUri,
      exp: Date.now() + 5 * 60 * 1000,
    })
  );
}

function issueAccessToken(clientId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600; // 1 year
  return hmacSign(JSON.stringify({ t: "token", c: clientId, exp }));
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

// ─── Authorization approval page ─────────────────────────────────────────────

function authPage(opts: {
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  state?: string;
  error?: string;
}): string {
  const needsPin = !!process.env.OAUTH_PIN;
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jan CRM – Zugriff erlauben</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    h1{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}
    .sub{color:#666;font-size:.875rem;margin-bottom:1.5rem;line-height:1.5}
    .client{font-weight:600;color:#111}
    label{display:block;font-size:.85rem;font-weight:500;margin-bottom:.4rem;color:#333}
    input[type=password]{width:100%;padding:.7rem 1rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;outline:none;transition:border .2s}
    input[type=password]:focus{border-color:#2563eb}
    .error{color:#dc2626;font-size:.85rem;margin-bottom:1rem;padding:.6rem;background:#fef2f2;border-radius:6px}
    button{width:100%;margin-top:1rem;padding:.8rem;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:500;cursor:pointer;transition:background .2s}
    button:hover{background:#1d4ed8}
    .note{margin-top:1.2rem;font-size:.78rem;color:#999;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <h1>Zugriff erlauben</h1>
    <p class="sub"><span class="client">${opts.clientName ?? "Claude"}</span> möchte auf dein CRM zugreifen und Kontakte, Deals und Aufgaben verwalten.</p>
    ${opts.error ? `<div class="error">${opts.error}</div>` : ""}
    <form method="POST">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="code_challenge_method" value="S256">
      <input type="hidden" name="redirect_uri" value="${opts.redirectUri}">
      <input type="hidden" name="code_challenge" value="${opts.codeChallenge}">
      <input type="hidden" name="client_id" value="${encodeURIComponent(opts.clientId)}">
      <input type="hidden" name="state" value="${opts.state ?? ""}">
      ${needsPin
        ? `<label for="pin">PIN</label>
           <input type="password" id="pin" name="pin" placeholder="Deine OAUTH_PIN eingeben" autocomplete="off" autofocus required>`
        : ""}
      <button type="submit">Erlauben</button>
    </form>
    <p class="note">Diese Genehmigung gilt für ein Jahr.</p>
  </div>
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
    const pin = process.env.OAUTH_PIN;

    // state may come from params (GET flow) or from the POST body (form re-submission).
    // Always prefer params.state, fall back to what was POSTed or queried.
    const state: string | undefined =
      params.state ?? req.body?.state ?? req.query?.state ?? undefined;

    if (req.method === "POST") {
      if (pin) {
        const submitted = String(req.body?.pin ?? "");
        if (submitted !== pin) {
          res.status(200).send(
            authPage({
              clientName: client.client_name,
              redirectUri: params.redirectUri,
              codeChallenge: params.codeChallenge,
              clientId: client.client_id,
              state,
              error: "Falsche PIN. Bitte erneut versuchen.",
            })
          );
          return;
        }
      }

      const code = issueAuthCode(client.client_id, params.codeChallenge, params.redirectUri);
      const url = new URL(params.redirectUri);
      url.searchParams.set("code", code);
      // state is required by Claude.ai — always include it if present
      if (state) url.searchParams.set("state", state);
      res.redirect(url.toString());
    } else {
      res.send(
        authPage({
          clientName: client.client_name,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          clientId: client.client_id,
          state,
        })
      );
    }
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = hmacVerify(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    const parsed = JSON.parse(data) as { t: string; ch: string; exp: number };
    if (parsed.t !== "code") throw new Error("Invalid authorization code type");
    if (Date.now() > parsed.exp) throw new Error("Authorization code expired");
    return parsed.ch;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const data = hmacVerify(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    const parsed = JSON.parse(data) as { t: string; c: string; exp: number };
    if (parsed.t !== "code") throw new Error("Invalid authorization code type");
    if (Date.now() > parsed.exp) throw new Error("Authorization code expired");
    if (parsed.c !== client.client_id) throw new Error("client_id mismatch");

    return {
      access_token: issueAccessToken(client.client_id),
      token_type: "Bearer",
      expires_in: 365 * 24 * 3600,
    };
  },

  async exchangeRefreshToken(client: OAuthClientInformationFull): Promise<OAuthTokens> {
    return {
      access_token: issueAccessToken(client.client_id),
      token_type: "Bearer",
      expires_in: 365 * 24 * 3600,
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = hmacVerify(token);
    if (!data) throw new Error("Invalid access token");
    const parsed = JSON.parse(data) as { t: string; c: string; exp: number };
    if (parsed.t !== "token") throw new Error("Invalid token type");
    if (Math.floor(Date.now() / 1000) > parsed.exp) throw new Error("Access token expired");
    return {
      token,
      clientId: parsed.c,
      scopes: [],
      expiresAt: parsed.exp,
    };
  },
};
