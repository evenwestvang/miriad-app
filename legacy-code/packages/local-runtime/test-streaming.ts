/**
 * WebSocket Streaming Test for Artifact Events
 * Verifies that artifact changes broadcast via tymbal.artifact()
 */

import { createServer } from "./src/server.js";
import { resetArtifactStorage } from "./src/artifact-storage.js";
import WebSocket from "ws";

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const CHANNEL = "stream-test";

async function main() {
  resetArtifactStorage();

  const server = createServer({
    agents: {},
    port: PORT,
  });

  await server.start();
  console.log(`\n🔌 Testing WebSocket streaming at ws://localhost:${PORT}\n`);

  // Collect received frames
  const receivedFrames: any[] = [];

  // Connect WebSocket to the channel (using threadId param)
  const ws = new WebSocket(`ws://localhost:${PORT}/?threadId=${CHANNEL}`);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      console.log("✅ WebSocket connected\n");
      resolve();
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connection timeout")), 5000);
  });

  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString().trim());
    receivedFrames.push(frame);
    console.log(`📨 Received frame: ${JSON.stringify(frame).slice(0, 100)}...`);
  });

  // Give WS time to stabilize
  await sleep(100);

  try {
    // Test 1: Create artifact - should broadcast "create" event
    console.log("\n1. Creating artifact (expecting 'create' broadcast)...");
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "stream-test-doc",
        type: "doc",
        title: "Streaming Test",
        tldr: "Testing WebSocket broadcast",
        content: "# Test",
        createdBy: "cicada",
      }),
    });

    await sleep(200);

    // Test 2: Update artifact - should broadcast "update" event
    console.log("\n2. Updating artifact (expecting 'update' broadcast)...");
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts/stream-test-doc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedBy: "cicada",
        title: "Updated Title",
      }),
    });

    await sleep(200);

    // Test 3: Archive artifact - should broadcast "archive" event
    console.log("\n3. Archiving artifact (expecting 'archive' broadcast)...");
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts/stream-test-doc?updatedBy=cicada`, {
      method: "DELETE",
    });

    await sleep(200);

    // Verify received frames
    console.log("\n" + "=".repeat(60));
    console.log("📊 RESULTS");
    console.log("=".repeat(60));

    const artifactFrames = receivedFrames.filter((f) => f.artifact);
    console.log(`\nTotal frames received: ${receivedFrames.length}`);
    console.log(`Artifact frames received: ${artifactFrames.length}`);

    if (artifactFrames.length === 0) {
      console.log("\n❌ No artifact frames received - streaming may not be working");
      process.exit(1);
    }

    // Check for each action type
    const actions = artifactFrames.map((f) => f.artifact.action);
    console.log(`\nActions received: ${actions.join(", ")}`);

    const hasCreate = actions.includes("create");
    const hasUpdate = actions.includes("update");
    const hasArchive = actions.includes("archive");

    console.log(`\n  ✅ create: ${hasCreate ? "YES" : "NO"}`);
    console.log(`  ✅ update: ${hasUpdate ? "YES" : "NO"}`);
    console.log(`  ✅ archive: ${hasArchive ? "YES" : "NO"}`);

    if (hasCreate && hasUpdate && hasArchive) {
      console.log("\n✅ WebSocket streaming verified! All artifact events broadcast correctly.\n");
    } else {
      console.log("\n⚠️ Some events missing - check broadcast callback wiring.\n");
      process.exit(1);
    }

    // Show sample frame structure
    console.log("Sample artifact frame:");
    console.log(JSON.stringify(artifactFrames[0], null, 2));

  } finally {
    ws.close();
    await server.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
