/**
 * esbuild configuration for Lambda bundling
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

// Get the directory of this config file for import.meta.url shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await esbuild.build({
  entryPoints: ["lambda.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist/lambda.mjs",
  format: "esm",  // Use ESM to support import.meta.url in SDK
  sourcemap: true,
  minify: false,
  // Banner to ensure import.meta.url works in Lambda ESM context
  banner: {
    js: `
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
`.trim(),
  },
  external: [
    // AWS SDK v3 is available in Lambda runtime
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-apigatewaymanagementapi",
    "@aws-sdk/client-lambda",
  ],
});

console.log("Build complete: dist/lambda.js");
