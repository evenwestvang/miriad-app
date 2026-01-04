#!/usr/bin/env npx tsx
/**
 * E2E test script for Attachment API
 * Run with: npx tsx test-attachments.ts
 */

import { createServer } from './src/index.js';
import { createSqliteStorage } from '@cikada/storage/sqlite';
import { rmSync, existsSync } from 'node:fs';

const PORT = 3398;
const BASE = `http://localhost:${PORT}`;
const CHANNEL_NAME = 'attachment-test';
const DB_PATH = ':memory:';

// Helper to create multipart form-data body
function createMultipartBody(
  filename: string,
  content: Buffer | string,
  fields: Record<string, string> = {}
): { body: Buffer; boundary: string } {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
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

  // Determine MIME type from filename
  let mimeType = 'application/octet-stream';
  if (filename.endsWith('.png')) mimeType = 'image/png';
  else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) mimeType = 'image/jpeg';
  else if (filename.endsWith('.pdf')) mimeType = 'application/pdf';
  else if (filename.endsWith('.mp3')) mimeType = 'audio/mpeg';

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

async function main() {
  // Clean up test attachments directory
  const attachmentsDir = './attachments';
  if (existsSync(attachmentsDir)) {
    rmSync(attachmentsDir, { recursive: true });
  }

  // Create storage
  const storage = createSqliteStorage({ path: DB_PATH });
  await storage.initialize();

  // Create and start server
  const server = createServer({ storage, port: PORT });
  await server.start();

  console.log(`\n🧪 Running Attachment E2E tests against ${BASE}\n`);

  let channelId: string;

  try {
    // Test 0: Create a channel first
    console.log('0. POST /channels - Create test channel');
    const createChannelRes = await fetch(`${BASE}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CHANNEL_NAME }),
    });
    const channelData = await createChannelRes.json() as { channel: { id: string } };
    channelId = channelData.channel.id;
    console.log(`   Status: ${createChannelRes.status}`);
    console.log(`   Channel ID: ${channelId}\n`);
    if (createChannelRes.status !== 201) throw new Error('Failed to create channel');

    // Test 1: Upload a PNG image
    console.log('1. POST /channels/:id/attachments - Upload PNG image');
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
      'test-image.png',
      pngData,
      { uploadedBy: 'test-user' }
    );

    const uploadRes = await fetch(`${BASE}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${pngBoundary}` },
      body: pngBody,
    });
    const uploaded = await uploadRes.json() as { success: boolean; attachment: { id: string; mimeType: string; size: number; filename: string; uploadedBy: string; url: string } };
    console.log(`   Status: ${uploadRes.status}`);
    console.log(`   Attachment ID: ${uploaded.attachment?.id}`);
    console.log(`   MIME: ${uploaded.attachment?.mimeType}`);
    console.log(`   Size: ${uploaded.attachment?.size} bytes`);
    console.log(`   Filename: ${uploaded.attachment?.filename}`);
    console.log(`   UploadedBy: ${uploaded.attachment?.uploadedBy}`);
    console.log(`   URL: ${uploaded.attachment?.url}\n`);
    if (uploadRes.status !== 201) throw new Error('Upload failed');
    if (uploaded.attachment?.mimeType !== 'image/png') throw new Error('Wrong MIME type');

    const attachmentId = uploaded.attachment.id;

    // Test 2: Download the attachment
    console.log('2. GET /channels/:id/attachments/:id - Download attachment');
    const downloadRes = await fetch(`${BASE}/channels/${channelId}/attachments/${attachmentId}`);
    const downloadedContent = Buffer.from(await downloadRes.arrayBuffer());
    console.log(`   Status: ${downloadRes.status}`);
    console.log(`   Content-Type: ${downloadRes.headers.get('content-type')}`);
    console.log(`   Content-Disposition: ${downloadRes.headers.get('content-disposition')}`);
    console.log(`   Size matches: ${downloadedContent.length === pngData.length}`);
    console.log(`   Content matches: ${downloadedContent.equals(pngData)}\n`);
    if (downloadRes.status !== 200) throw new Error('Download failed');
    if (!downloadedContent.equals(pngData)) throw new Error('Content mismatch');

    // Test 3: Upload without uploadedBy (should default to 'anonymous')
    console.log('3. POST /channels/:id/attachments - Upload without uploadedBy');
    const { body: anonBody, boundary: anonBoundary } = createMultipartBody(
      'anon-image.png',
      pngData
    );

    const anonRes = await fetch(`${BASE}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${anonBoundary}` },
      body: anonBody,
    });
    const anonUploaded = await anonRes.json() as { success: boolean; attachment: { uploadedBy: string } };
    console.log(`   Status: ${anonRes.status}`);
    console.log(`   UploadedBy: ${anonUploaded.attachment?.uploadedBy} (expected: anonymous)\n`);
    if (anonRes.status !== 201) throw new Error('Anonymous upload failed');
    if (anonUploaded.attachment?.uploadedBy !== 'anonymous') throw new Error('Expected anonymous uploader');

    // Test 4: 404 for missing attachment
    console.log('4. GET /channels/:id/attachments/missing - 404 test');
    const missingRes = await fetch(`${BASE}/channels/${channelId}/attachments/nonexistent-id`);
    console.log(`   Status: ${missingRes.status} (expected 404)\n`);
    if (missingRes.status !== 404) throw new Error('Expected 404 for missing attachment');

    // Test 5: Invalid content type (not allowed)
    console.log('5. POST /channels/:id/attachments - Reject non-allowed file type');
    const { body: txtBody, boundary: txtBoundary } = createMultipartBody(
      'test.txt',
      'Hello, World!'
    );

    const txtRes = await fetch(`${BASE}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${txtBoundary}` },
      body: txtBody,
    });
    console.log(`   Status: ${txtRes.status} (expected 400)\n`);
    if (txtRes.status !== 400) throw new Error('Expected 400 for non-allowed file type');

    // Test 6: Missing multipart boundary
    console.log('6. POST without multipart boundary - Validation test');
    const invalidRes = await fetch(`${BASE}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    console.log(`   Status: ${invalidRes.status} (expected 400)\n`);
    if (invalidRes.status !== 400) throw new Error('Expected 400 for invalid content-type');

    console.log('✅ All Attachment E2E tests passed!\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    await server.stop();
    await storage.close();
    // Clean up test attachments
    if (existsSync(attachmentsDir)) {
      rmSync(attachmentsDir, { recursive: true });
    }
  }
}

main();
