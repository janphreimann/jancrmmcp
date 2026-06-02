import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider } from "./oauth.js";
import { registerAllTools } from "./tools/index.js";

// Issuer URL must be known at startup (not per-request) because express-rate-limit
// inside mcpAuthRouter must be created once, not per request (Vercel serverless constraint).
const ISSUER_URL = new URL(
  process.env.SERVER_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT ?? 3000}`)
);

const app = express();
app.set("trust proxy", 1); // Required for correct rate limiting behind Vercel's proxy
app.use(express.json());

// Health check (unauthenticated)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "crm-mcp-server" });
});

// OAuth endpoints — router created ONCE at startup to satisfy express-rate-limit constraints
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: ISSUER_URL }));

// MCP endpoint — protected by OAuth Bearer token
app.all(
  "/mcp",
  requireBearerAuth({ verifier: oauthProvider }),
  async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = new McpServer({ name: "crm-mcp-server", version: "1.0.0" });
    registerAllTools(server);

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
