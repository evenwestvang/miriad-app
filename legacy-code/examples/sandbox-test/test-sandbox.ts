import "dotenv/config";
import { createServer } from "@cikada/local-runtime";

// Start server with sandbox enabled - no agents needed for claude-code
const server = createServer({
  agents: {},
  port: 3099,
  enableSandbox: true,
});

server.start().then(() => {
  console.log("Server ready with sandbox enabled");
  console.log("Test with:");
  console.log("  curl -X POST http://localhost:3099/thread -H 'Content-Type: application/json' -d '{\"agentName\":\"claude-code\"}'");
}).catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

// Handle shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});
