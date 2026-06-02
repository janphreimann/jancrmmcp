import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider } from "./oauth.js";
import { registerAllTools } from "./tools/index.js";

function getBaseUrl(req?: import("express").Request): string {
  if (process.env.SERVER_URL) return process.env.SERVER_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "http://localhost:3000";
}

const app = express();
app.use(express.json());

// Health check (unauthenticated)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "crm-mcp-server" });
});

// OAuth endpoints (/.well-known/oauth-authorization-server, /oauth/authorize, /oauth/token, /oauth/register)
// Must be mounted before the MCP route
app.use((req, res, next) => {
  const issuerUrl = new URL(getBaseUrl(req));
  return mcpAuthRouter({ provider: oauthProvider, issuerUrl })(req, res, next);
});

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
