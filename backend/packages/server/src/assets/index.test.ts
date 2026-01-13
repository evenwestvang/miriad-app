/**
 * Tests for Asset Storage Module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createFilesystemAssetStorage,
  createS3AssetStorage,
  type AssetStorage,
} from './index.js';

// =============================================================================
// Test Helpers
// =============================================================================

let testDir: string;
let storage: AssetStorage;

async function createTestFile(name: string, content: string): Promise<string> {
  const filePath = path.join(testDir, 'source', name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

async function createTestBinaryFile(name: string, size: number): Promise<string> {
  const filePath = path.join(testDir, 'source', name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(size, 'x');
  await fs.writeFile(filePath, buffer);
  return filePath;
}

// =============================================================================
// Filesystem Asset Storage Tests
// =============================================================================

describe('createFilesystemAssetStorage', () => {
  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `cast-asset-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    storage = createFilesystemAssetStorage({
      assetsDir: path.join(testDir, 'assets'),
      maxFileSize: 1024 * 1024, // 1MB for tests
    });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveAsset', () => {
    describe('from file path', () => {
      it('saves a file from path successfully', async () => {
        const sourcePath = await createTestFile('test-image.png', 'fake png data');

        const result = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'my-image.png',
          source: { type: 'path', path: sourcePath },
        });

        expect(result.contentType).toBe('image/png');
        expect(result.fileSize).toBe(13); // 'fake png data'.length
        expect(result.filePath).toContain('channel-1');
        expect(result.filePath).toContain('my-image.png');

        // Verify file exists
        const exists = await storage.assetExists('channel-1', 'my-image.png');
        expect(exists).toBe(true);
      });

      it('creates channel directory if it does not exist', async () => {
        const sourcePath = await createTestFile('test.pdf', 'pdf content');

        await storage.saveAsset({
          channelId: 'new-channel',
          slug: 'doc.pdf',
          source: { type: 'path', path: sourcePath },
        });

        const exists = await storage.assetExists('new-channel', 'doc.pdf');
        expect(exists).toBe(true);
      });

      it('throws error when source file does not exist', async () => {
        await expect(
          storage.saveAsset({
            channelId: 'channel-1',
            slug: 'missing.png',
            source: { type: 'path', path: '/nonexistent/file.png' },
          })
        ).rejects.toThrow('Source file not found');
      });

      it('throws error when file exceeds size limit', async () => {
        // Create a file larger than 1MB limit
        const sourcePath = await createTestBinaryFile('large.bin', 2 * 1024 * 1024);

        await expect(
          storage.saveAsset({
            channelId: 'channel-1',
            slug: 'large.bin',
            source: { type: 'path', path: sourcePath },
          })
        ).rejects.toThrow(/exceeds maximum allowed/);
      });

      it('detects correct MIME type from slug extension', async () => {
        const sourcePath = await createTestFile('source', 'data');

        const pngResult = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'image.png',
          source: { type: 'path', path: sourcePath },
        });
        expect(pngResult.contentType).toBe('image/png');

        const jpgResult = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'photo.jpg',
          source: { type: 'path', path: sourcePath },
        });
        expect(jpgResult.contentType).toBe('image/jpeg');

        const pdfResult = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'doc.pdf',
          source: { type: 'path', path: sourcePath },
        });
        expect(pdfResult.contentType).toBe('application/pdf');
      });
    });

    describe('from base64', () => {
      it('saves base64 data successfully', async () => {
        const content = 'Hello, World!';
        const base64Data = Buffer.from(content).toString('base64');

        const result = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'data.json',
          source: { type: 'base64', data: base64Data },
        });

        expect(result.contentType).toBe('application/json');
        expect(result.fileSize).toBe(content.length);

        // Verify content
        const readBack = await storage.readAsset('channel-1', 'data.json');
        expect(readBack.toString()).toBe(content);
      });

      it('throws error when base64 data exceeds size limit', async () => {
        // Create base64 data larger than 1MB limit
        const largeData = Buffer.alloc(2 * 1024 * 1024, 'x').toString('base64');

        await expect(
          storage.saveAsset({
            channelId: 'channel-1',
            slug: 'large.bin',
            source: { type: 'base64', data: largeData },
          })
        ).rejects.toThrow(/exceeds maximum allowed/);
      });

      it('handles empty base64 data', async () => {
        const result = await storage.saveAsset({
          channelId: 'channel-1',
          slug: 'empty.txt',
          source: { type: 'base64', data: '' },
        });

        expect(result.fileSize).toBe(0);
      });
    });
  });

  describe('readAsset', () => {
    it('reads a previously saved asset', async () => {
      const content = 'test content';
      const sourcePath = await createTestFile('test.txt', content);

      await storage.saveAsset({
        channelId: 'channel-1',
        slug: 'test.txt',
        source: { type: 'path', path: sourcePath },
      });

      const data = await storage.readAsset('channel-1', 'test.txt');
      expect(data.toString()).toBe(content);
    });

    it('reads binary data correctly', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const base64Data = binaryData.toString('base64');

      await storage.saveAsset({
        channelId: 'channel-1',
        slug: 'binary.bin',
        source: { type: 'base64', data: base64Data },
      });

      const readBack = await storage.readAsset('channel-1', 'binary.bin');
      expect(readBack).toEqual(binaryData);
    });

    it('throws error for non-existent asset', async () => {
      await expect(
        storage.readAsset('channel-1', 'nonexistent.png')
      ).rejects.toThrow('Asset not found: nonexistent.png');
    });

    it('throws error for non-existent channel', async () => {
      await expect(
        storage.readAsset('nonexistent-channel', 'file.png')
      ).rejects.toThrow('Asset not found');
    });
  });

  describe('assetExists', () => {
    it('returns true for existing asset', async () => {
      const sourcePath = await createTestFile('test.png', 'data');

      await storage.saveAsset({
        channelId: 'channel-1',
        slug: 'test.png',
        source: { type: 'path', path: sourcePath },
      });

      const exists = await storage.assetExists('channel-1', 'test.png');
      expect(exists).toBe(true);
    });

    it('returns false for non-existent asset', async () => {
      const exists = await storage.assetExists('channel-1', 'nonexistent.png');
      expect(exists).toBe(false);
    });

    it('returns false for non-existent channel', async () => {
      const exists = await storage.assetExists('nonexistent-channel', 'file.png');
      expect(exists).toBe(false);
    });
  });

  describe('deleteAsset', () => {
    it('deletes an existing asset', async () => {
      const sourcePath = await createTestFile('test.png', 'data');

      await storage.saveAsset({
        channelId: 'channel-1',
        slug: 'test.png',
        source: { type: 'path', path: sourcePath },
      });

      // Verify exists
      let exists = await storage.assetExists('channel-1', 'test.png');
      expect(exists).toBe(true);

      // Delete
      await storage.deleteAsset('channel-1', 'test.png');

      // Verify deleted
      exists = await storage.assetExists('channel-1', 'test.png');
      expect(exists).toBe(false);
    });

    it('does not throw when deleting non-existent asset', async () => {
      // Should not throw - idempotent delete
      await expect(
        storage.deleteAsset('channel-1', 'nonexistent.png')
      ).resolves.toBeUndefined();
    });

    it('does not throw when deleting from non-existent channel', async () => {
      await expect(
        storage.deleteAsset('nonexistent-channel', 'file.png')
      ).resolves.toBeUndefined();
    });
  });

  describe('getAssetPath', () => {
    it('returns correct path structure', () => {
      const assetPath = storage.getAssetPath('channel-123', 'image.png');
      expect(assetPath).toContain('channel-123');
      expect(assetPath).toContain('image.png');
      expect(assetPath).toContain(path.join(testDir, 'assets'));
    });

    it('returns consistent paths', () => {
      const path1 = storage.getAssetPath('channel-1', 'test.png');
      const path2 = storage.getAssetPath('channel-1', 'test.png');
      expect(path1).toBe(path2);
    });
  });

  describe('configuration', () => {
    it('uses custom assetsDir', async () => {
      const customDir = path.join(testDir, 'custom-assets');
      const customStorage = createFilesystemAssetStorage({
        assetsDir: customDir,
      });

      const sourcePath = await createTestFile('test.png', 'data');

      await customStorage.saveAsset({
        channelId: 'channel-1',
        slug: 'test.png',
        source: { type: 'path', path: sourcePath },
      });

      const assetPath = customStorage.getAssetPath('channel-1', 'test.png');
      expect(assetPath.startsWith(customDir)).toBe(true);
    });

    it('uses custom maxFileSize', async () => {
      const smallStorage = createFilesystemAssetStorage({
        assetsDir: path.join(testDir, 'small-assets'),
        maxFileSize: 100, // Very small limit
      });

      const sourcePath = await createTestFile('test.txt', 'x'.repeat(200));

      await expect(
        smallStorage.saveAsset({
          channelId: 'channel-1',
          slug: 'test.txt',
          source: { type: 'path', path: sourcePath },
        })
      ).rejects.toThrow(/exceeds maximum allowed/);
    });
  });
});

// =============================================================================
// S3 Asset Storage Tests
// =============================================================================

describe('createS3AssetStorage', () => {
  it('throws error when bucket name is not provided', () => {
    // Clear env vars
    const originalBucketName = process.env.ASSETS_BUCKET_NAME;
    delete process.env.ASSETS_BUCKET_NAME;

    try {
      expect(() => createS3AssetStorage()).toThrow(
        'S3 asset storage requires ASSETS_BUCKET_NAME environment variable'
      );
    } finally {
      // Restore env
      if (originalBucketName) {
        process.env.ASSETS_BUCKET_NAME = originalBucketName;
      }
    }
  });

  it('creates storage with bucket name from config', () => {
    const s3Storage = createS3AssetStorage({ bucketName: 'test-bucket' });
    expect(s3Storage).toBeDefined();
    expect(s3Storage.saveAsset).toBeDefined();
    expect(s3Storage.readAsset).toBeDefined();
    expect(s3Storage.assetExists).toBeDefined();
    expect(s3Storage.deleteAsset).toBeDefined();
    expect(s3Storage.getAssetPath).toBeDefined();
    expect(s3Storage.readAssetStream).toBeDefined();
  });

  it('returns correct S3 key format from getAssetPath', () => {
    const s3Storage = createS3AssetStorage({ bucketName: 'test-bucket' });
    const key = s3Storage.getAssetPath('channel-123', 'image.png');
    expect(key).toBe('channel-123/image.png');
  });

  it('creates storage with bucket name from env var', () => {
    const originalBucketName = process.env.ASSETS_BUCKET_NAME;
    process.env.ASSETS_BUCKET_NAME = 'env-bucket';

    try {
      const s3Storage = createS3AssetStorage();
      expect(s3Storage).toBeDefined();
      // Verify it uses the bucket by checking the key format
      const key = s3Storage.getAssetPath('channel-1', 'test.png');
      expect(key).toBe('channel-1/test.png');
    } finally {
      // Restore env
      if (originalBucketName) {
        process.env.ASSETS_BUCKET_NAME = originalBucketName;
      } else {
        delete process.env.ASSETS_BUCKET_NAME;
      }
    }
  });
});

// =============================================================================
// Asset Storage Factory Tests
// =============================================================================

describe('createAssetStorage factory', () => {
  const originalBackend = process.env.ASSET_STORAGE_BACKEND;
  const originalBucketName = process.env.ASSETS_BUCKET_NAME;

  afterEach(() => {
    // Restore env vars
    if (originalBackend) {
      process.env.ASSET_STORAGE_BACKEND = originalBackend;
    } else {
      delete process.env.ASSET_STORAGE_BACKEND;
    }
    if (originalBucketName) {
      process.env.ASSETS_BUCKET_NAME = originalBucketName;
    } else {
      delete process.env.ASSETS_BUCKET_NAME;
    }
  });

  it('returns filesystem storage by default', async () => {
    delete process.env.ASSET_STORAGE_BACKEND;

    // Need to dynamically import to get fresh module
    const { createAssetStorage } = await import('./index.js');
    const factoryStorage = createAssetStorage();

    // Filesystem storage uses full paths with directory separators
    const assetPath = factoryStorage.getAssetPath('channel-123', 'test.png');
    expect(assetPath).toContain('channel-123');
    expect(assetPath).toContain('test.png');
    // Filesystem paths are longer (include directory prefix)
    expect(assetPath.length).toBeGreaterThan('channel-123/test.png'.length);
  });

  it('returns S3 storage when ASSET_STORAGE_BACKEND=s3', async () => {
    process.env.ASSET_STORAGE_BACKEND = 's3';
    process.env.ASSETS_BUCKET_NAME = 'test-bucket';

    const { createAssetStorage } = await import('./index.js');
    const factoryStorage = createAssetStorage();

    // S3 storage uses simple key format
    const assetPath = factoryStorage.getAssetPath('channel-123', 'test.png');
    expect(assetPath).toBe('channel-123/test.png');
  });

  it('returns filesystem storage for unknown backend value', async () => {
    process.env.ASSET_STORAGE_BACKEND = 'unknown';

    const { createAssetStorage } = await import('./index.js');
    const factoryStorage = createAssetStorage();

    // Should fall back to filesystem
    const assetPath = factoryStorage.getAssetPath('channel-123', 'test.png');
    expect(assetPath.length).toBeGreaterThan('channel-123/test.png'.length);
  });
});
