/**
 * Asset Storage Module
 *
 * Handles binary asset storage on the filesystem.
 * Pattern: `{ASSETS_DIR}/{channelId}/{slug}`
 *
 * Future: S3 support (will throw explicit "Not implemented" for now)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getMimeType, MAX_ASSET_FILE_SIZE } from '@cast/core';

// =============================================================================
// Types
// =============================================================================

export interface AssetStorageConfig {
  /** Base directory for assets (default: ~/.cast/assets) */
  assetsDir: string;
  /** Maximum file size in bytes (default: MAX_ASSET_FILE_SIZE from @cast/core) */
  maxFileSize?: number;
}

export interface SaveAssetInput {
  channelId: string;
  slug: string;
  /** Either file path or base64-encoded data */
  source: { type: 'path'; path: string } | { type: 'base64'; data: string };
}

export interface SaveAssetResult {
  /** Full path where file was saved */
  filePath: string;
  /** Detected MIME type */
  contentType: string;
  /** File size in bytes */
  fileSize: number;
}

/** Result from reading an asset as a stream */
export interface ReadAssetStreamResult {
  /** Readable stream of the asset content */
  stream: ReadableStream<Uint8Array>;
  /** Content length in bytes (if known) */
  contentLength?: number;
  /** Content type (if known) */
  contentType?: string;
}

export interface AssetStorage {
  /** Save a binary asset to storage */
  saveAsset(input: SaveAssetInput): Promise<SaveAssetResult>;

  /** Read an asset from storage (buffers entire file - use readAssetStream for large files) */
  readAsset(channelId: string, slug: string): Promise<Buffer>;

  /** Read an asset as a stream (for large files - avoids memory pressure) */
  readAssetStream?(channelId: string, slug: string): Promise<ReadAssetStreamResult>;

  /** Check if an asset exists */
  assetExists(channelId: string, slug: string): Promise<boolean>;

  /** Delete an asset */
  deleteAsset(channelId: string, slug: string): Promise<void>;

  /** Get the file path for an asset (for direct serving) */
  getAssetPath(channelId: string, slug: string): string;
}

// =============================================================================
// Default Config
// =============================================================================

// Use /tmp/.cast-dev for local development, ~/.cast/assets for production
const DEFAULT_ASSETS_DIR = process.env.NODE_ENV === 'production'
  ? path.join(process.env.HOME || '/tmp', '.cast', 'assets')
  : '/tmp/.cast-dev/assets';
// Use shared constant from @cast/core as the single source of truth

// =============================================================================
// Filesystem Asset Storage Implementation
// =============================================================================

export function createFilesystemAssetStorage(
  config: Partial<AssetStorageConfig> = {}
): AssetStorage {
  const assetsDir = config.assetsDir || process.env.ASSETS_DIR || DEFAULT_ASSETS_DIR;
  const maxFileSize = config.maxFileSize ?? MAX_ASSET_FILE_SIZE;

  /**
   * Ensure directory exists
   */
  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Get the full path for an asset
   */
  function getAssetPath(channelId: string, slug: string): string {
    return path.join(assetsDir, channelId, slug);
  }

  /**
   * Save an asset to the filesystem
   */
  async function saveAsset(input: SaveAssetInput): Promise<SaveAssetResult> {
    const { channelId, slug, source } = input;
    const filePath = getAssetPath(channelId, slug);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await ensureDir(dir);

    let data: Buffer;

    if (source.type === 'path') {
      // Read from file path
      try {
        const stats = await fs.stat(source.path);
        if (stats.size > maxFileSize) {
          throw new Error(
            `File size ${stats.size} exceeds maximum allowed ${maxFileSize} bytes`
          );
        }
        data = await fs.readFile(source.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Source file not found: ${source.path}`);
        }
        throw err;
      }
    } else {
      // Decode base64
      data = Buffer.from(source.data, 'base64');
      if (data.length > maxFileSize) {
        throw new Error(
          `File size ${data.length} exceeds maximum allowed ${maxFileSize} bytes`
        );
      }
    }

    // Write to destination
    await fs.writeFile(filePath, data);

    // Detect MIME type from slug extension
    const contentType = getMimeType(slug);

    return {
      filePath,
      contentType,
      fileSize: data.length,
    };
  }

  /**
   * Read an asset from the filesystem
   */
  async function readAsset(channelId: string, slug: string): Promise<Buffer> {
    const filePath = getAssetPath(channelId, slug);
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Asset not found: ${slug}`);
      }
      throw err;
    }
  }

  /**
   * Check if an asset exists
   */
  async function assetExists(channelId: string, slug: string): Promise<boolean> {
    const filePath = getAssetPath(channelId, slug);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an asset
   */
  async function deleteAsset(channelId: string, slug: string): Promise<void> {
    const filePath = getAssetPath(channelId, slug);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already deleted, not an error
        return;
      }
      throw err;
    }
  }

  return {
    saveAsset,
    readAsset,
    assetExists,
    deleteAsset,
    getAssetPath,
  };
}

// =============================================================================
// S3 Asset Storage
// =============================================================================

import { createS3AssetStorage } from './s3.js';
export { createS3AssetStorage };

// =============================================================================
// Asset Storage Factory
// =============================================================================

/**
 * Create an asset storage backend based on environment configuration.
 *
 * - Default (local dev): filesystem storage
 * - Production: S3 storage when ASSET_STORAGE_BACKEND=s3
 */
export function createAssetStorage(): AssetStorage {
  const backend = process.env.ASSET_STORAGE_BACKEND || 'filesystem';

  if (backend === 's3') {
    return createS3AssetStorage();
  }

  return createFilesystemAssetStorage();
}
