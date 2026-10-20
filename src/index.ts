import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider, handleDevicePoll } from "./oauth.js";
import { buildContext } from "./context.js";
import { registerTools, type ToolProfile } from "./tools/index.js";
import { isInitialize, loadInstructions } from "./instructions.js";
import { ISSUER_URL } from "./issuer.js";

const app = express();
app.set("trust proxy", 1); // Required for correct rate limiting behind Vercel's proxy
app.use(express.json());

// Health check (unauthenticated)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "crm-mcp-server" });
});

// OAuth endpoints — router created ONCE at startup to satisfy express-rate-limit constraints
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: ISSUER_URL }));

// Wird von der Pairing-Seite aus oauthProvider.authorize() gepollt, bis der
// dort angezeigte Code in der CRM-Web-App eingelöst wurde. Siehe oauth.ts.
app.post("/auth/device-poll", handleDevicePoll);

// MCP endpoints — protected by OAuth Bearer token. Same server, same tokens,
// two tool profiles (tools/index.ts → ToolProfile): /mcp for Jan's own
// clients (claude.ai, Claude Code), /mcp/agent for the desktop agents. A
// token is not bound to either path: the protected-resource metadata names
// the server root as the resource, which covers both.
const PROFILE_BY_PATH: Record<string, ToolProfile> = { "/mcp": "jan", "/mcp/agent": "agent" };

app.all(
  Object.keys(PROFILE_BY_PATH),
  requireBearerAuth({ verifier: oauthProvider }),
  async (req, res) => {
    // Stateless: Der Server schickt nie von sich aus etwas an den Client. Ein
    // GET-Stream würde auf Vercel nur bis zum 300-s-Timeout offen hängen, der
    // Client verbindet sich neu, und die Instanz läuft dauerhaft (Fluid
    // Provisioned Memory). 405 ist laut MCP-Spec erlaubt, Clients fallen dann
    // auf reines POST zurück. Steht bewusst hinter requireBearerAuth, damit
    // ein GET mit abgelaufenem Token weiterhin 401 und damit Re-Auth auslöst.
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
      return;
    }

    // Wer fragt, steht im Token — und nur daraus. Der Ctx trägt das
    // Supabase-Access-Token des Nutzers, ab hier greift die RLS des CRM.
    const extra = req.auth?.extra as { sub?: string; supabaseAccessToken?: string } | undefined;
    if (!extra?.sub || !extra.supabaseAccessToken) {
      res.status(401).json({ error: "Token carries no user identity — please reconnect" });
      return;
    }

    let ctx;
    try {
      ctx = await buildContext(extra.sub, extra.supabaseAccessToken);
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : "Access denied" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const instructions = isInitialize(req.body) ? await loadInstructions(ctx) : undefined;
    const server = new McpServer({ name: "crm-mcp-server", version: "1.0.0" }, instructions ? { instructions } : undefined);
    registerTools(server, ctx, PROFILE_BY_PATH[req.path.replace(/\/+$/, "")] ?? "jan");

    transport.onclose = () => server.close().catch(() => {});

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
);

// Local dev
if (process.env.VERCEL !== "1") {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CRM MCP Server running on port ${PORT}`);
    console.log(`MCP endpoints: http://0.0.0.0:${PORT}/mcp (Jan), /mcp/agent (desktop agents)`);
  });
}

export default app;
