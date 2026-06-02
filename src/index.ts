import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireApiKey } from "./auth.js";
import { registerAllTools } from "./tools/index.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "crm-mcp-server" });
});

// Stateless mode: each request gets its own McpServer + transport.
// Works with both Railway (persistent process) and Vercel (serverless).
app.all("/mcp", requireApiKey, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking needed
  });
  const server = new McpServer({ name: "crm-mcp-server", version: "1.0.0" });
  registerAllTools(server);

  transport.onclose = () => server.close().catch(() => {});

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Local dev
if (process.env.VERCEL !== "1") {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CRM MCP Server running on port ${PORT}`);
    console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  });
}

export default app;
