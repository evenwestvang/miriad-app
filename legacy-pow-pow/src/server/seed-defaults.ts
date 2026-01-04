#!/usr/bin/env node
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { seedRootArtifacts } from "./defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultsDir = path.join(__dirname, "..", "..", "defaults");

if (!fs.existsSync(defaultsDir)) {
  console.error(`Defaults directory not found: ${defaultsDir}`);
  process.exit(1);
}

// Seed #root with system.agent artifacts
// force=true to add any new agents that don't exist yet
seedRootArtifacts(defaultsDir, true);

console.error("Done!");
