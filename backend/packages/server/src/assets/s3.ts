/**
 * S3 Asset Storage Implementation
 *
 * Stores binary assets in S3 with pattern: `{channelId}/{slug}`
 * Configured via environment variables:
 * - ASSETS_BUCKET_NAME: S3 bucket name
 * - ASSETS_BUCKET_REGION: AWS region
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import { getMimeType, MAX_ASSET_FILE_SIZE } from '@cast/core';
import type { AssetStorage, SaveAssetInput, SaveAssetResult, ReadAssetStreamResult } from './index.js';

// =============================================================================
// Types
// =============================================================================

export interface S3AssetStorageConfig {
  /** S3 bucket name */
  bucketName: string;
  /** AWS region */
  region: string;
  /** Maximum file size in bytes (default: MAX_ASSET_FILE_SIZE from @cast/core) */
  maxFileSize?: number;
}

// =============================================================================
// Default Config
// =============================================================================

// Use shared constant from @cast/core as the single source of truth

// =============================================================================
// S3 Asset Storage Implementation
// =============================================================================

export function createS3AssetStorage(
  config: Partial<S3AssetStorageConfig> = {}
): AssetStorage {
  const bucketName = config.bucketName || process.env.ASSETS_BUCKET_NAME;
  const region = config.region || process.env.ASSETS_BUCKET_REGION || 'us-east-1';
  const maxFileSize = config.maxFileSize ?? MAX_ASSET_FILE_SIZE;

  if (!bucketName) {
    throw new Error('S3 asset storage requires ASSETS_BUCKET_NAME environment variable');
  }

  const client = new S3Client({ region });

  /**
   * Get the S3 key for an asset
   */
  function getAssetPath(channelId: string, slug: string): string {
    return `${channelId}/${slug}`;
  }

  /**
   * Save an asset to S3
   */
  async function saveAsset(input: SaveAssetInput): Promise<SaveAssetResult> {
    const { channelId, slug, source } = input;
    const key = getAssetPath(channelId, slug);

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

    // Detect MIME type from slug extension
    const contentType = getMimeType(slug);

    // Upload to S3
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );

    return {
      filePath: key,
      contentType,
      fileSize: data.length,
    };
  }

  /**
   * Read an asset from S3
   */
  async function readAsset(channelId: string, slug: string): Promise<Buffer> {
    const key = getAssetPath(channelId, slug);

    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );

      if (!response.Body) {
        throw new Error(`Asset not found: ${slug}`);
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        throw new Error(`Asset not found: ${slug}`);
      }
      throw err;
    }
  }

  /**
   * Check if an asset exists in S3
   */
  async function assetExists(channelId: string, slug: string): Promise<boolean> {
    const key = getAssetPath(channelId, slug);

    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') {
        return false;
      }
      // For other errors, we assume it doesn't exist to be safe
      return false;
    }
  }

  /**
   * Delete an asset from S3
   */
  async function deleteAsset(channelId: string, slug: string): Promise<void> {
    const key = getAssetPath(channelId, slug);

    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );
    } catch (err) {
      // S3 DeleteObject doesn't throw for non-existent keys, but handle any errors gracefully
      if ((err as { name?: string }).name !== 'NoSuchKey') {
        throw err;
      }
    }
  }

  /**
   * Read an asset from S3 as a stream (for large files)
   * This avoids buffering the entire file in memory
   */
  async function readAssetStream(channelId: string, slug: string): Promise<ReadAssetStreamResult> {
    const key = getAssetPath(channelId, slug);

    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );

      if (!response.Body) {
        throw new Error(`Asset not found: ${slug}`);
      }

      // The S3 SDK returns a Readable stream (Node.js) or ReadableStream (browser)
      // We need to convert it to a web ReadableStream for Response compatibility
      const nodeStream = response.Body as AsyncIterable<Uint8Array>;

      const webStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of nodeStream) {
              controller.enqueue(chunk);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return {
        stream: webStream,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        throw new Error(`Asset not found: ${slug}`);
      }
      throw err;
    }
  }

  return {
    saveAsset,
    readAsset,
    readAssetStream,
    assetExists,
    deleteAsset,
    getAssetPath,
  };
}
