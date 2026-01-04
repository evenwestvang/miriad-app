/**
 * E2E test script for Artifact API
 * Run with: npx tsx test-artifacts.ts
 */

import { createServer } from "./src/server.js";
import { resetArtifactStorage } from "./src/artifact-storage.js";

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const CHANNEL = "test-channel";

async function main() {
  // Reset storage for clean test
  resetArtifactStorage();

  // Start server
  const server = createServer({
    agents: {},
    port: PORT,
  });

  await server.start();
  console.log(`\n🧪 Running E2E tests against ${BASE}\n`);

  try {
    // Test 1: Create artifact
    console.log("1. POST /channel/:id/artifacts - Create artifact");
    const createRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "test-doc",
        type: "doc",
        title: "Test Document",
        tldr: "A test document for E2E testing",
        content: "# Test\n\nThis is a test document.",
        createdBy: "cicada",
      }),
    });
    const created = await createRes.json();
    console.log(`   Status: ${createRes.status}`);
    console.log(`   Created: ${created.slug} (id: ${created.id})\n`);
    if (createRes.status !== 201) throw new Error("Create failed");

    // Test 2: Read artifact
    console.log("2. GET /channel/:id/artifacts/:slug - Read artifact");
    const readRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/test-doc`);
    const read = await readRes.json();
    console.log(`   Status: ${readRes.status}`);
    console.log(`   Read: ${read.slug}, title: "${read.title}"\n`);
    if (readRes.status !== 200) throw new Error("Read failed");

    // Test 3: Create more artifacts for testing
    console.log("3. Creating additional artifacts for list/tree tests...");
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "phase-1",
        type: "task",
        title: "Phase 1",
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
        slug: "task-a",
        type: "task",
        title: "Task A",
        tldr: "First subtask",
        content: "Subtask details",
        parentSlug: "phase-1",
        status: "done",
        assignees: ["cicada"],
        createdBy: "lead",
      }),
    });
    await fetch(`${BASE}/channel/${CHANNEL}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "task-b",
        type: "task",
        title: "Task B",
        tldr: "Second subtask with [[task-a]] reference",
        content: "Depends on [[task-a]]",
        parentSlug: "phase-1",
        status: "pending",
        assignees: ["tymbal"],
        createdBy: "lead",
      }),
    });
    console.log("   Created: phase-1, task-a, task-b\n");

    // Test 4: List artifacts
    console.log("4. GET /channel/:id/artifacts - List all");
    const listRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`);
    const list = await listRes.json();
    console.log(`   Status: ${listRes.status}`);
    console.log(`   Count: ${list.artifacts.length}`);
    console.log(`   Slugs: ${list.artifacts.map((a: any) => a.slug).join(", ")}\n`);

    // Test 5: List with filter
    console.log("5. GET /channel/:id/artifacts?type=task - Filter by type");
    const filterRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts?type=task`);
    const filtered = await filterRes.json();
    console.log(`   Status: ${filterRes.status}`);
    console.log(`   Count: ${filtered.artifacts.length}`);
    console.log(`   Slugs: ${filtered.artifacts.map((a: any) => a.slug).join(", ")}\n`);

    // Test 6: Tree view
    console.log("6. GET /channel/:id/artifacts/tree - Glob tree");
    const treeRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/tree`);
    const tree = await treeRes.json();
    console.log(`   Status: ${treeRes.status}`);
    console.log(`   Root nodes: ${tree.tree.length}`);
    const phase1 = tree.tree.find((n: any) => n.slug === "phase-1");
    if (phase1) {
      console.log(`   phase-1 children: ${phase1.children.map((c: any) => c.slug).join(", ")}\n`);
    }

    // Test 7: Update with CAS
    console.log("7. PATCH /channel/:id/artifacts/:slug - CAS update");
    const casRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/task-b`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedBy: "tymbal",
        changes: [
          { field: "status", oldValue: "pending", newValue: "in_progress" },
        ],
      }),
    });
    const casUpdated = await casRes.json();
    console.log(`   Status: ${casRes.status}`);
    console.log(`   New status: ${casUpdated.status}\n`);
    if (casRes.status !== 200) throw new Error("CAS update failed");

    // Test 8: CAS conflict
    console.log("8. PATCH - CAS conflict test");
    const conflictRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/task-b`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedBy: "other",
        changes: [
          { field: "status", oldValue: "pending", newValue: "done" }, // Wrong oldValue
        ],
      }),
    });
    const conflict = await conflictRes.json();
    console.log(`   Status: ${conflictRes.status} (expected 409)`);
    console.log(`   Conflict field: ${conflict.conflict?.field}\n`);
    if (conflictRes.status !== 409) throw new Error("Expected CAS conflict");

    // Test 9: Simple update (non-CAS)
    console.log("9. PATCH - Simple update (non-CAS)");
    const simpleRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/test-doc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedBy: "cicada",
        title: "Updated Test Document",
        tldr: "Updated description",
      }),
    });
    const simpleUpdated = await simpleRes.json();
    console.log(`   Status: ${simpleRes.status}`);
    console.log(`   New title: "${simpleUpdated.title}"`);
    console.log(`   Version: ${simpleUpdated.version}\n`);

    // Test 10: Archive
    console.log("10. DELETE /channel/:id/artifacts/:slug - Archive");
    const archiveRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts/test-doc?updatedBy=cicada`, {
      method: "DELETE",
    });
    const archived = await archiveRes.json();
    console.log(`   Status: ${archiveRes.status}`);
    console.log(`   Archived: ${archived.archived}`);
    console.log(`   Final status: ${archived.artifact.status}\n`);

    // Test 11: Verify archived not in list
    console.log("11. Verify archived artifact excluded from list");
    const finalListRes = await fetch(`${BASE}/channel/${CHANNEL}/artifacts`);
    const finalList = await finalListRes.json();
    const hasArchived = finalList.artifacts.some((a: any) => a.slug === "test-doc");
    console.log(`   Count: ${finalList.artifacts.length}`);
    console.log(`   test-doc in list: ${hasArchived} (expected: false)\n`);

    console.log("✅ All E2E tests passed!\n");
  } catch (err) {
    console.error("❌ Test failed:", err);
    process.exit(1);
  } finally {
    await server.stop();
  }
}

main();
