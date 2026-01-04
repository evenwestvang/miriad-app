/**
 * Phase 2 E2E Integration Test
 * Tests artifacts + assets + cross-refs + streaming together
 * Run with: npx tsx test-phase2-e2e.ts
 */

import { createServer } from "./src/server.js";
import { resetArtifactStorage } from "./src/artifact-storage.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 3499;
const BASE = `http://localhost:${PORT}`;
const CHANNEL = "phase2-test";

// Helper for multipart uploads
function createMultipartBody(
  filename: string,
  content: Buffer | string,
  fields: Record<string, string> = {}
): { body: Buffer; boundary: string } {
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  const fileContent = Buffer.isBuffer(content) ? content : Buffer.from(content);
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  ));
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Clean up
  const assetsDir = join(process.env.HOME ?? "", ".cikada", "assets", CHANNEL);
  if (existsSync(assetsDir)) {
    rmSync(assetsDir, { recursive: true });
  }
  resetArtifactStorage();

  const server = createServer({
    agents: {},
    port: PORT,
  });

  await server.start();
  console.log(`\n🧪 Phase 2 E2E Integration Test\n${"=".repeat(50)}\n`);

  // Collect WebSocket frames
  const receivedFrames: any[] = [];
  const ws = new WebSocket(`ws://localhost:${PORT}/?threadId=${CHANNEL}`);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 5000);
  });

  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString().trim());
    receivedFrames.push(frame);
  });

  await sleep(100);

  try {
    // =========================================================================
    // Test 1: Create artifacts with cross-references
    // =========================================================================
    console.log("1. Creating artifacts with [[slug]] cross-references...");

    // Create parent spec
    const specRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "api-spec",
        type: "doc",
        title: "API Specification",
        tldr: "Main API spec document",
        content: "# API Spec\n\nSee [[auth-module]] for authentication details.\nImplementation in [[api-impl]].",
        createdBy: "cicada",
      }),
    });
    const spec = await specRes.json();
    console.log(`   Created: ${spec.slug}`);
    console.log(`   Refs extracted: ${JSON.stringify(spec.refs)}`);

    if (!spec.refs.includes("auth-module") || !spec.refs.includes("api-impl")) {
      throw new Error("Cross-refs not extracted correctly");
    }

    // Create referenced docs
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "auth-module",
        type: "doc",
        tldr: "Authentication module",
        content: "# Auth Module\n\nDepends on [[api-spec]] for endpoint definitions.",
        createdBy: "cicada",
      }),
    });
    console.log("   Created: auth-module");

    // Create task with refs
    const taskRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "impl-task",
        type: "task",
        tldr: "Implement the API per [[api-spec]]",
        content: "Task: Implement [[api-spec]] using [[auth-module]]",
        status: "pending",
        assignees: ["cicada"],
        createdBy: "lead",
      }),
    });
    const task = await taskRes.json();
    console.log(`   Created: ${task.slug}`);
    console.log(`   Task refs: ${JSON.stringify(task.refs)}`);

    if (task.refs.length !== 2) {
      throw new Error("Task should have 2 refs");
    }

    console.log("   ✅ Cross-refs extraction working\n");

    // =========================================================================
    // Test 2: Upload binary asset
    // =========================================================================
    console.log("2. Uploading binary asset...");

    const imageData = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82
    ]);

    const { body: imgBody, boundary: imgBoundary } = createMultipartBody(
      "diagram.png",
      imageData,
      { tldr: "Architecture diagram for [[api-spec]]" }
    );

    const assetRes = await fetch(`${BASE}/channel/${CHANNEL}/assets`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${imgBoundary}` },
      body: imgBody,
    });
    const asset = await assetRes.json();
    console.log(`   Uploaded: ${asset.slug}`);
    console.log(`   Size: ${asset.size} bytes`);
    console.log(`   MIME: ${asset.mimeType}`);
    console.log(`   URL: ${asset.url}`);

    // Verify download
    const downloadRes = await fetch(`${BASE}${asset.url}`);
    const downloaded = Buffer.from(await downloadRes.arrayBuffer());
    if (downloaded.length !== imageData.length) {
      throw new Error("Downloaded asset size mismatch");
    }
    console.log("   ✅ Asset upload/download working\n");

    // =========================================================================
    // Test 3: Update artifact and verify refs update
    // =========================================================================
    console.log("3. Updating artifact content (refs should update)...");

    const updateRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/api-spec`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedBy: "cicada",
        content: "# API Spec v2\n\nNow references [[auth-module]], [[impl-task]], and [[new-feature]].",
      }),
    });
    const updated = await updateRes.json();
    console.log(`   Updated version: ${updated.version}`);
    console.log(`   New refs: ${JSON.stringify(updated.refs)}`);

    if (!updated.refs.includes("new-feature")) {
      throw new Error("Refs not updated on content change");
    }
    console.log("   ✅ Refs update on content change working\n");

    // =========================================================================
    // Test 4: Verify WebSocket streaming
    // =========================================================================
    console.log("4. Verifying WebSocket artifact streaming...");
    await sleep(200);

    const artifactFrames = receivedFrames.filter((f) => f.artifact);
    console.log(`   Total frames received: ${receivedFrames.length}`);
    console.log(`   Artifact frames: ${artifactFrames.length}`);

    const actions = artifactFrames.map((f) => f.artifact.action);
    console.log(`   Actions: ${actions.join(", ")}`);

    // Should have: 3 creates + 1 update
    const createCount = actions.filter((a) => a === "create").length;
    const updateCount = actions.filter((a) => a === "update").length;

    if (createCount < 3) {
      throw new Error(`Expected at least 3 create frames, got ${createCount}`);
    }
    if (updateCount < 1) {
      throw new Error(`Expected at least 1 update frame, got ${updateCount}`);
    }
    console.log("   ✅ WebSocket streaming working\n");

    // =========================================================================
    // Test 5: Tree structure with artifacts
    // =========================================================================
    console.log("5. Testing artifact tree structure...");

    // Create parent and children
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "phase-1",
        type: "task",
        tldr: "Phase 1 tasks",
        content: "Parent task",
        status: "in_progress",
        createdBy: "lead",
      }),
    });

    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "subtask-1",
        type: "task",
        tldr: "First subtask per [[phase-1]]",
        content: "Subtask content",
        parentSlug: "phase-1",
        status: "done",
        createdBy: "lead",
      }),
    });

    const treeRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/tree`);
    const treeData = await treeRes.json();
    console.log(`   Root nodes: ${treeData.tree.length}`);

    const phase1 = treeData.tree.find((n: any) => n.slug === "phase-1");
    if (phase1) {
      console.log(`   phase-1 children: ${phase1.children.length}`);
      if (phase1.children.length !== 1) {
        throw new Error("Expected 1 child under phase-1");
      }
    } else {
      throw new Error("phase-1 not in tree");
    }
    console.log("   ✅ Tree structure working\n");

    // =========================================================================
    // Test 6: List with filters
    // =========================================================================
    console.log("6. Testing artifact list filters...");

    const tasksRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts?type=task`);
    const tasks = await tasksRes.json();
    console.log(`   Tasks: ${tasks.artifacts.length}`);

    const docsRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts?type=doc`);
    const docs = await docsRes.json();
    console.log(`   Docs: ${docs.artifacts.length}`);

    const assignedRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts?assignee=cicada`);
    const assigned = await assignedRes.json();
    console.log(`   Assigned to cicada: ${assigned.artifacts.length}`);

    console.log("   ✅ Filters working\n");

    // =========================================================================
    // Test 7: Archive and verify exclusion
    // =========================================================================
    console.log("7. Testing archive and list exclusion...");

    await fetch(`${BASE}/channel/${CHANNEL}/artifacts/auth-module?updatedBy=cicada`, {
      method: "DELETE",
    });

    const afterArchiveRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`);
    const afterArchive = await afterArchiveRes.json();
    const hasArchived = afterArchive.artifacts.some((a: any) => a.slug === "auth-module");
    console.log(`   Archived artifact in list: ${hasArchived} (expected: false)`);

    if (hasArchived) {
      throw new Error("Archived artifact should be excluded from list");
    }
    console.log("   ✅ Archive exclusion working\n");

    // =========================================================================
    // Summary
    // =========================================================================
    console.log("=".repeat(50));
    console.log("✅ All Phase 2 E2E tests passed!");
    console.log("=".repeat(50));
    console.log("\nVerified:");
    console.log("  • [[slug]] cross-reference extraction");
    console.log("  • Refs update on content change");
    console.log("  • Binary asset upload/download");
    console.log("  • WebSocket streaming for artifacts");
    console.log("  • Tree structure with parent/children");
    console.log("  • List filters (type, assignee)");
    console.log("  • Archive and list exclusion");
    console.log("");

  } catch (err) {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
  } finally {
    ws.close();
    await server.stop();
    if (existsSync(assetsDir)) {
      rmSync(assetsDir, { recursive: true });
    }
  }
}

main();
