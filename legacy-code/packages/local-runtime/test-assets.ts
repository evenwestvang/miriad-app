/**
 * E2E test script for Binary Asset API
 * Run with: npx tsx test-assets.ts
 */

import { createServer } from "./src/server.js";
import { resetArtifactStorage } from "./src/artifact-storage.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const CHANNEL = "asset-test";

// Helper to create multipart form-data body
function createMultipartBody(
  filename: string,
  content: Buffer | string,
  fields: Record<string, string> = {}
): { body: Buffer; boundary: string } {
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  // Add regular fields
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  // Add file
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

async function main() {
  // Clean up test artifacts directory
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
  console.log(`\n🧪 Running Binary Asset E2E tests against ${BASE}\n`);

  try {
    // Test 1: Upload a text file
    console.log("1. POST /channel/:id/assets - Upload text file");
    const textContent = "Hello, World! This is a test file.";
    const { body: textBody, boundary: textBoundary } = createMultipartBody(
      "test.txt",
      textContent
    );

    const uploadRes = await fetch(`${BASE}/channel/${CHANNEL}/assets`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${textBoundary}` },
      body: textBody,
    });
    const uploaded = await uploadRes.json();
    console.log(`   Status: ${uploadRes.status}`);
    console.log(`   Slug: ${uploaded.slug}`);
    console.log(`   Size: ${uploaded.size} bytes`);
    console.log(`   MIME: ${uploaded.mimeType}`);
    console.log(`   URL: ${uploaded.url}\n`);
    if (uploadRes.status !== 201) throw new Error("Upload failed");

    // Test 2: Download the file
    console.log("2. GET /channel/:id/assets/:filename - Download file");
    const downloadRes = await fetch(`${BASE}/channel/${CHANNEL}/assets/test.txt`);
    const downloadedContent = await downloadRes.text();
    console.log(`   Status: ${downloadRes.status}`);
    console.log(`   Content-Type: ${downloadRes.headers.get("content-type")}`);
    console.log(`   Content matches: ${downloadedContent === textContent}\n`);
    if (downloadRes.status !== 200) throw new Error("Download failed");
    if (downloadedContent !== textContent) throw new Error("Content mismatch");

    // Test 3: Upload PNG (binary)
    console.log("3. POST /channel/:id/assets - Upload binary (PNG)");
    // Minimal valid PNG (1x1 transparent pixel)
    const pngData = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, // IEND chunk
      0x42, 0x60, 0x82
    ]);

    const { body: pngBody, boundary: pngBoundary } = createMultipartBody(
      "pixel.png",
      pngData,
      { tldr: "1x1 transparent pixel" }
    );

    const pngRes = await fetch(`${BASE}/channel/${CHANNEL}/assets`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${pngBoundary}` },
      body: pngBody,
    });
    const pngUploaded = await pngRes.json();
    console.log(`   Status: ${pngRes.status}`);
    console.log(`   MIME: ${pngUploaded.mimeType}`);
    console.log(`   Size: ${pngUploaded.size} bytes`);
    console.log(`   tldr: ${pngUploaded.tldr}\n`);
    if (pngRes.status !== 201) throw new Error("PNG upload failed");
    if (pngUploaded.mimeType !== "image/png") throw new Error("Wrong MIME type");

    // Test 4: Download PNG
    console.log("4. GET /channel/:id/assets/pixel.png - Download PNG");
    const pngDownloadRes = await fetch(`${BASE}/channel/${CHANNEL}/assets/pixel.png`);
    const pngDownloaded = Buffer.from(await pngDownloadRes.arrayBuffer());
    console.log(`   Status: ${pngDownloadRes.status}`);
    console.log(`   Content-Type: ${pngDownloadRes.headers.get("content-type")}`);
    console.log(`   Size matches: ${pngDownloaded.length === pngData.length}\n`);
    if (pngDownloadRes.status !== 200) throw new Error("PNG download failed");

    // Test 5: Upload with custom slug
    console.log("5. POST /channel/:id/assets - Upload with custom slug");
    const { body: slugBody, boundary: slugBoundary } = createMultipartBody(
      "original-name.json",
      '{"test": true}',
      { slug: "custom-slug.json", tldr: "JSON with custom slug" }
    );

    const slugRes = await fetch(`${BASE}/channel/${CHANNEL}/assets`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${slugBoundary}` },
      body: slugBody,
    });
    const slugUploaded = await slugRes.json();
    console.log(`   Status: ${slugRes.status}`);
    console.log(`   Original filename: ${slugUploaded.filename}`);
    console.log(`   Custom slug: ${slugUploaded.slug}\n`);
    if (slugRes.status !== 201) throw new Error("Custom slug upload failed");
    if (slugUploaded.slug !== "custom-slug.json") throw new Error("Slug not applied");

    // Test 6: 404 for missing asset
    console.log("6. GET /channel/:id/assets/missing.txt - 404 test");
    const missingRes = await fetch(`${BASE}/channel/${CHANNEL}/assets/missing.txt`);
    console.log(`   Status: ${missingRes.status} (expected 404)\n`);
    if (missingRes.status !== 404) throw new Error("Expected 404 for missing asset");

    // Test 7: Invalid filename (directory traversal attempt)
    console.log("7. GET with path traversal - Security test");
    const traversalRes = await fetch(`${BASE}/channel/${CHANNEL}/assets/..%2F..%2Fetc%2Fpasswd`);
    console.log(`   Status: ${traversalRes.status} (expected 400 or 404)\n`);
    if (traversalRes.status !== 400 && traversalRes.status !== 404) {
      throw new Error("Path traversal should be blocked");
    }

    // Test 8: Missing multipart boundary
    console.log("8. POST without multipart boundary - Validation test");
    const invalidRes = await fetch(`${BASE}/channel/${CHANNEL}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    console.log(`   Status: ${invalidRes.status} (expected 400)\n`);
    if (invalidRes.status !== 400) throw new Error("Expected 400 for invalid content-type");

    console.log("✅ All Binary Asset E2E tests passed!\n");
  } catch (err) {
    console.error("❌ Test failed:", err);
    process.exit(1);
  } finally {
    await server.stop();
    // Clean up test assets
    if (existsSync(assetsDir)) {
      rmSync(assetsDir, { recursive: true });
    }
  }
}

main();
