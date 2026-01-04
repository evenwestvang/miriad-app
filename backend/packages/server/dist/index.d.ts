/**
 * @cast/server - HTTP API and WebSocket server
 *
 * Exports the Hono app for use by different adapters (local dev, Lambda, etc.)
 */
import { Hono } from 'hono';
export declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export default app;
//# sourceMappingURL=index.d.ts.map