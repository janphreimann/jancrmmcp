import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider, handleDevicePoll } from "./oauth.js";
import { buildContext } from "./context.js";
import { registerAllTools } from "./tools/index.js";
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

// MCP endpoint — protected by OAuth Bearer token
app.all(
  "/mcp",
  requireBearerAuth({ verifier: oauthProvider }),
  async (req, res) => {
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
    const server = new McpServer({ name: "crm-mcp-server", version: "1.0.0" });
    registerAllTools(server, ctx);

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
    console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  });
}

export default app;
