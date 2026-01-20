#!/usr/bin/env node
/**
 * @miriad-systems/assets-mcp CLI
 *
 * MCP server for uploading and downloading Cast channel assets.
 *
 * Required environment variables:
 *   CAST_API_URL         - Base URL of the Cast server
 *   CAST_CONTAINER_TOKEN - Container authentication token
 *   CAST_CHANNEL_ID      - Channel ID to operate on
 *
 * Usage:
 *   npx @miriad-systems/assets-mcp
 *
 * Or with environment variables:
 *   CAST_API_URL=https://cast.example.com \
 *   CAST_CONTAINER_TOKEN=xxx \
 *   CAST_CHANNEL_ID=xxx \
 *   npx @miriad-systems/assets-mcp
 */

import { main } from "./index.js";

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
