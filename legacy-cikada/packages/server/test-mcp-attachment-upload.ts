#!/usr/bin/env npx tsx
/**
 * E2E test for attachment_upload MCP tool
 *
 * Tests the full flow:
 * 1. Start the Cikada server
 * 2. Create a test channel
 * 3. Create a test file
 * 4. Call the attachment upload function directly (simulating MCP tool call)
 * 5. Verify the upload succeeded and file is accessible
 */

import { createServer } from './src/index.js';
import { createSqliteStorage } from '@cikada/storage/sqlite';
import { rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const PORT = 3397;
const BASE = `http://localhost:${PORT}`;
const CHANNEL_NAME = 'mcp-attachment-test';
const DB_PATH = ':memory:';
const TEST_DIR = './test-workspace';

// Import the MIME types and helper functions we need to test
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".pdf": "application/pdf",
};

function getMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? null;
}

function createMultipartBody(
  filename: string,
  fileData: Buffer,
  mimeType: string,
  uploadedBy: string
): { body: Buffer; boundary: string } {
  const boundary = "----CikadaBoundary" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="uploadedBy"\r\n\r\n` +
    `${uploadedBy}\r\n`
  ));

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

// Simulate the MCP tool's attachmentUpload function
async function attachmentUpload(params: {
  path: string;
  channel?: string;
  filename?: string;
}, apiUrl: string, channelId: string, callsign: string): Promise<{
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}> {
  const filePath = params.path;
  const effectiveChannelId = params.channel ?? channelId;

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const mimeType = getMimeType(filePath);
  if (!mimeType) {
    const ext = path.extname(filePath).toLowerCase();
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const fileData = readFileSync(filePath);
  const filename = params.filename ?? path.basename(filePath);

  const { body, boundary } = createMultipartBody(
    filename,
    fileData,
    mimeType,
    callsign
  );

  const url = `${apiUrl}/channels/${effectiveChannelId}/attachments`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });

  const data = await response.json() as { error?: string; attachment?: any };

  if (!response.ok) {
    throw new Error(`Upload failed: ${data.error ?? response.status}`);
  }

  const attachment = data.attachment;
  return {
    id: attachment.id,
    url: attachment.url,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

async function main() {
  // Clean up
  const attachmentsDir = './attachments';
  if (existsSync(attachmentsDir)) {
    rmSync(attachmentsDir, { recursive: true });
  }
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }

  // Create test workspace
  mkdirSync(TEST_DIR, { recursive: true });

  // Create storage and server
  const storage = createSqliteStorage({ path: DB_PATH });
  await storage.initialize();

  const server = createServer({ storage, port: PORT });
  await server.start();

  console.log(`\n🧪 Running attachment_upload MCP Tool E2E tests against ${BASE}\n`);

  let channelId: string;

  try {
    // Test 0: Create a channel
    console.log('0. Create test channel');
    const createChannelRes = await fetch(`${BASE}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CHANNEL_NAME }),
    });
    const channelData = await createChannelRes.json() as { channel: { id: string } };
    channelId = channelData.channel.id;
    console.log(`   Channel ID: ${channelId}\n`);

    // Test 1: Create and upload a PNG file
    console.log('1. Upload PNG via MCP tool simulation');

    // Create a minimal PNG file
    const pngData = Buffer.from([
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

    const testPngPath = path.join(TEST_DIR, 'test-image.png');
    writeFileSync(testPngPath, pngData);

    const pngResult = await attachmentUpload(
      { path: testPngPath },
      BASE,
      channelId,
      'test-agent'
    );

    console.log(`   ID: ${pngResult.id}`);
    console.log(`   URL: ${pngResult.url}`);
    console.log(`   Filename: ${pngResult.filename}`);
    console.log(`   MIME: ${pngResult.mimeType}`);
    console.log(`   Size: ${pngResult.size} bytes`);

    if (pngResult.mimeType !== 'image/png') throw new Error('Wrong MIME type');
    if (pngResult.filename !== 'test-image.png') throw new Error('Wrong filename');
    if (pngResult.size !== pngData.length) throw new Error('Wrong size');
    console.log('   ✓ PNG upload verified\n');

    // Test 2: Verify file is downloadable
    console.log('2. Verify uploaded file is accessible');
    const downloadRes = await fetch(`${BASE}${pngResult.url}`);
    const downloadedData = Buffer.from(await downloadRes.arrayBuffer());

    console.log(`   Status: ${downloadRes.status}`);
    console.log(`   Content-Type: ${downloadRes.headers.get('content-type')}`);
    console.log(`   Content matches: ${downloadedData.equals(pngData)}`);

    if (downloadRes.status !== 200) throw new Error('Download failed');
    if (!downloadedData.equals(pngData)) throw new Error('Content mismatch');
    console.log('   ✓ Download verified\n');

    // Test 3: Upload with custom filename
    console.log('3. Upload with custom filename');
    const customResult = await attachmentUpload(
      { path: testPngPath, filename: 'custom-name.png' },
      BASE,
      channelId,
      'test-agent'
    );

    console.log(`   Filename: ${customResult.filename} (expected: custom-name.png)`);
    if (customResult.filename !== 'custom-name.png') throw new Error('Custom filename not applied');
    console.log('   ✓ Custom filename verified\n');

    // Test 4: Upload PDF
    console.log('4. Upload PDF file');
    const pdfPath = path.join(TEST_DIR, 'test-doc.pdf');
    // Minimal PDF
    const pdfData = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n101\n%%EOF');
    writeFileSync(pdfPath, pdfData);

    const pdfResult = await attachmentUpload(
      { path: pdfPath },
      BASE,
      channelId,
      'test-agent'
    );

    console.log(`   MIME: ${pdfResult.mimeType} (expected: application/pdf)`);
    if (pdfResult.mimeType !== 'application/pdf') throw new Error('Wrong PDF MIME type');
    console.log('   ✓ PDF upload verified\n');

    // Test 5: Reject unsupported file type
    console.log('5. Reject unsupported file type');
    const txtPath = path.join(TEST_DIR, 'test.txt');
    writeFileSync(txtPath, 'Hello, World!');

    try {
      await attachmentUpload(
        { path: txtPath },
        BASE,
        channelId,
        'test-agent'
      );
      throw new Error('Should have rejected .txt file');
    } catch (err) {
      if (err instanceof Error && err.message.includes('Unsupported file type')) {
        console.log('   ✓ Correctly rejected .txt file\n');
      } else {
        throw err;
      }
    }

    // Test 6: File not found error
    console.log('6. Handle file not found');
    try {
      await attachmentUpload(
        { path: '/nonexistent/file.png' },
        BASE,
        channelId,
        'test-agent'
      );
      throw new Error('Should have thrown file not found');
    } catch (err) {
      if (err instanceof Error && err.message.includes('File not found')) {
        console.log('   ✓ Correctly handled missing file\n');
      } else {
        throw err;
      }
    }

    console.log('✅ All attachment_upload MCP tool E2E tests passed!\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    await server.stop();
    await storage.close();

    // Clean up
    if (existsSync(attachmentsDir)) {
      rmSync(attachmentsDir, { recursive: true });
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  }
}

main();
