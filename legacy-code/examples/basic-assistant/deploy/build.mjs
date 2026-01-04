#!/usr/bin/env node
/**
 * Build script for AWS Lambda deployment
 *
 * Bundles all Lambda handlers into a single file for SAM deployment.
 */

import * as esbuild from "esbuild";
import { rm, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

async function build() {
  console.log("Building Lambda bundle...");

  // Clean dist
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  // Bundle
  await esbuild.build({
    entryPoints: [join(__dirname, "lambda.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: join(distDir, "lambda.js"),
    format: "cjs", // Lambda requires CommonJS for non-ESM handlers
    sourcemap: true,
    minify: false, // Keep readable for debugging
    external: [
      // AWS SDK v3 is available in Lambda runtime
      "@aws-sdk/*",
    ],
  });

  console.log("Build complete: deploy/dist/lambda.js");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
