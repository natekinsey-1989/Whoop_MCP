import express from "express";
import cron from "node-cron";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAuthRoutes } from "./auth.js";
import { registerTools } from "./tools.js";
import { runDateRangePull } from "./pull.js";

const mcpServer = new McpServer({
  name: "whoop-history-server",
  version: "1.0.0",
});

registerTools(mcpServer);

const app = express();
app.use(express.json());

// CORS — required for Claude's connector preflight check to succeed.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-session-id, Mcp-Session-Id"
  );
  res.header("Access-Control-Expose-Headers", "mcp-session-id, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

registerAuthRoutes(app);

// Force-override the Accept header so the MCP SDK's strict media-type check
// always passes regardless of what the connecting client actually sent.
// DIAGNOSTIC: X-Debug-Accept-Override response header lets us confirm via
// curl whether this middleware executes. Remove once the 406/connector
// registration issue is confirmed resolved.
app.post("/mcp", (req, res, next) => {
  req.headers.accept = "application/json, text/event-stream";
  res.setHeader("X-Debug-Accept-Override", "applied");
  next();
}, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => {
  res.json({ service: "whoop-history-server", status: "running" });
});

// ─── Daily cron: 6:00am ET ──────────────────────────────────────────────────
// Runs an incremental sync that:
//   1. Extends coverage forward to today (cheap — only fetches the new gap)
//   2. Force-refreshes a small 3-day rolling window so activity tag edits
//      made in the Whoop app are picked up automatically without a manual
//      whoop_full_history(force=true) call.
//
// Pattern is written directly in ET ("0 6 * * *") with the timezone option,
// so node-cron handles EST/EDT transitions automatically — this avoids the
// UTC/ET ambiguity that exists in the V2 server's cron pattern.

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

cron.schedule(
  "0 6 * * *",
  async () => {
    console.log("[cron] Daily sync starting...");
    try {
      const end = isoDate(new Date());
      const start = isoDate(new Date(Date.now() - 3 * 86400000));
      await runDateRangePull(start, end, true); // force=true: catch tag edits in rolling window
      console.log("[cron] Daily sync complete");
    } catch (err) {
      console.error("[cron] Daily sync failed:", err);
    }
  },
  { timezone: "America/New_York" }
);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`[server] whoop-history-server running on port ${PORT}`);
  console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);
  if (!process.env.WHOOP_REFRESH_TOKEN) {
    console.log("[server] No tokens. Visit /auth to authorize.");
  }
});
