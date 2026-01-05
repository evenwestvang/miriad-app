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
import { getMimeType } from '@cast/core';

// =============================================================================
// Types
// =============================================================================

export interface AssetStorageConfig {
  /** Base directory for assets (default: ~/.cast/assets) */
  assetsDir: string;
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize: number;
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

export interface AssetStorage {
  /** Save a binary asset to storage */
  saveAsset(input: SaveAssetInput): Promise<SaveAssetResult>;

  /** Read an asset from storage */
  readAsset(channelId: string, slug: string): Promise<Buffer>;

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
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// =============================================================================
// Filesystem Asset Storage Implementation
// =============================================================================

export function createFilesystemAssetStorage(
  config: Partial<AssetStorageConfig> = {}
): AssetStorage {
  const assetsDir = config.assetsDir || process.env.ASSETS_DIR || DEFAULT_ASSETS_DIR;
  const maxFileSize = config.maxFileSize || DEFAULT_MAX_FILE_SIZE;

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
// S3 Asset Storage Stub
// =============================================================================

export function createS3AssetStorage(): AssetStorage {
  const notImplemented = (): never => {
    throw new Error('S3 asset storage is not implemented. Use filesystem storage instead.');
  };

  return {
    saveAsset: notImplemented,
    readAsset: notImplemented,
    assetExists: notImplemented,
    deleteAsset: notImplemented,
    getAssetPath: notImplemented,
  };
}
