/**
 * Artifact REST API endpoints and SSE event wiring
 *
 * REST Endpoints per design spec:
 * - GET    /api/channels/:channel/artifacts           - List with filters
 * - GET    /api/channels/:channel/artifacts/:slug     - Get single artifact
 * - POST   /api/channels/:channel/artifacts           - Create artifact (409 if exists)
 * - PUT    /api/channels/:channel/artifacts/:slug     - Update artifact
 * - DELETE /api/channels/:channel/artifacts/:slug     - Hard delete (admin only)
 * - GET    /api/channels/:channel/artifacts/:slug/versions         - List versions
 * - POST   /api/channels/:channel/artifacts/:slug/versions         - Checkpoint version
 * - GET    /api/channels/:channel/artifacts/:slug/versions/:version - Get specific version
 *
 * Raw content endpoint (for SPAs):
 * - GET    /boards/:channel/:slug                     - Raw content with MIME type
 *
 * SSE Events:
 * - artifact: { action: "created"|"updated"|"archived", artifact: Artifact }
 * - artifact_version: { slug, version, message, mentions[] }
 */

import http from "http";
import Busboy from "busboy";
import { store, Artifact, Status, readAsset, saveAsset, validateFileSize, MAX_FILE_SIZE_BYTES } from "./store.js";

// MIME types by file extension
const MIME_TYPES: Record<string, string> = {
  // Text
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  // Code
  js: "text/javascript",
  ts: "text/typescript",
  json: "application/json",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  // Images
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // Other
  pdf: "application/pdf",
  wasm: "application/wasm",
};

function getMimeType(slug: string, contentType?: string): string {
  // Use explicit content type if provided
  if (contentType) return contentType;
  // Infer from extension
  const ext = slug.split(".").pop()?.toLowerCase();
  return ext ? MIME_TYPES[ext] || "text/plain" : "text/plain";
}

// Slug validation regex (same as MCP tool)
const SLUG_REGEX = /^[a-z0-9-]+\.[a-z0-9]+$/;

/**
 * Handle POST /api/channels/:channel/upload - file upload endpoint
 * Uses busboy for streaming multipart parsing (no temp files)
 * Returns true if handled, false otherwise
 */
export function handleUploadRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const match = url.pathname.match(/^\/api\/channels\/([^/]+)\/upload$/);
  if (!match || req.method !== "POST") return false;

  const channel = decodeURIComponent(match[1]);

  // Check Content-Length early for 413 rejection
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > MAX_FILE_SIZE_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`,
    }));
    return true;
  }

  // Check content-type is multipart
  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Content-Type must be multipart/form-data" }));
    return true;
  }

  // Collected form data
  const fields: Record<string, string> = {};
  let fileData: Buffer | null = null;
  let fileSize = 0;
  let fileMimeType = "application/octet-stream";
  let hasFile = false;
  let aborted = false;

  try {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: 1, // Only one file allowed
      },
    });

    busboy.on("field", (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on("file", (fieldname, stream, info) => {
      if (fieldname !== "file") {
        stream.resume(); // Discard unexpected files
        return;
      }

      hasFile = true;
      fileMimeType = info.mimeType || "application/octet-stream";

      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => {
        fileSize += chunk.length;
        // Double-check size limit during streaming
        if (fileSize > MAX_FILE_SIZE_BYTES) {
          aborted = true;
          stream.destroy();
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`,
          }));
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", () => {
        if (!aborted) {
          fileData = Buffer.concat(chunks);
        }
      });

      stream.on("limit", () => {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`,
        }));
      });
    });

    busboy.on("finish", () => {
      if (aborted) return;

      // Validate required fields
      const slug = fields["slug"];
      if (!slug) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "slug is required" }));
        return;
      }

      // Validate slug format
      if (!SLUG_REGEX.test(slug)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Invalid slug format. Must be lowercase alphanumeric with hyphens and file extension (e.g., 'my-file.png')",
        }));
        return;
      }

      if (!hasFile || !fileData) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "file is required" }));
        return;
      }

      // Check if slug already exists
      const existing = store.getArtifact(channel, slug);
      if (existing) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Artifact with slug '${slug}' already exists in #${channel}` }));
        return;
      }

      // Determine content type from extension or uploaded mime type
      const ext = slug.split(".").pop()?.toLowerCase();
      const contentType = ext && MIME_TYPES[ext] ? MIME_TYPES[ext] : fileMimeType;

      // Handle optional fields
      const tldr = fields["tldr"] || undefined;
      const title = fields["title"] || undefined;
      const parentSlug = fields["parentSlug"] || undefined;
      const sender = fields["sender"] || "web";

      // Generate placeholder tldr if not provided (for web UI uploads)
      const effectiveTldr = tldr || `Uploaded by @${sender} at ${new Date().toISOString()}`;
      const needsDescription = !tldr;

      try {
        // Save file to disk
        saveAsset(channel, slug, fileData);

        // Create artifact record
        const artifact = store.createArtifact({
          channel,
          slug,
          title,
          tldr: effectiveTldr,
          type: "code", // Assets use code type with binary handling
          content: "",  // Content stored in filesystem
          contentType,
          encoding: "file",
          status: "published",
          parentSlug,
          needsDescription,
          createdBy: sender,
        });

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          artifact: {
            slug: artifact.slug,
            channel: artifact.channel,
            path: artifact.path,
            contentType,
            size: fileSize,
            url: `/boards/${channel}/${slug}`,
            needsDescription,
          },
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to save file: ${err.message}` }));
      }
    });

    busboy.on("error", (err: Error) => {
      if (!aborted) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Upload error: ${err.message}` }));
      }
    });

    req.pipe(busboy);
  } catch (err: any) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Failed to process upload: ${err.message}` }));
  }

  return true;
}

/**
 * Handle /boards/:channel/:slug requests - serve raw artifact content
 * Returns true if handled, false otherwise
 */
export function handleBoardsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const match = url.pathname.match(/^\/boards\/([^/]+)\/(.+)$/);
  if (!match || req.method !== "GET") return false;

  const channel = decodeURIComponent(match[1]);
  const slug = decodeURIComponent(match[2]);

  const artifact = store.getArtifact(channel, slug);
  if (!artifact) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return true;
  }

  const mimeType = getMimeType(slug, artifact.contentType);

  // Handle file-backed binary assets
  if (artifact.encoding === "file") {
    const data = readAsset(channel, slug);
    if (!data) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Asset file not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
    return true;
  }

  // Text content
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": "no-cache",
  });
  res.end(artifact.content);
  return true;
}

/**
 * Handle artifact REST API requests
 * Returns true if the request was handled, false otherwise
 */
export function handleArtifactRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  // GET /api/channels/:channel/artifacts/:slug/versions/:version
  const versionMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/artifacts\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch && req.method === "GET") {
    const channel = decodeURIComponent(versionMatch[1]);
    const slug = decodeURIComponent(versionMatch[2]);
    const versionName = decodeURIComponent(versionMatch[3]);

    const version = store.getVersion(channel, slug, versionName);
    if (!version) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Version not found" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      slug,
      channel,
      version: version.versionName,
      message: version.message,
      content: version.content,
      tldr: version.tldr,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
    }));
    return true;
  }

  // GET /api/channels/:channel/artifacts/:slug/versions
  const versionsListMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/artifacts\/([^/]+)\/versions$/);
  if (versionsListMatch && req.method === "GET") {
    const channel = decodeURIComponent(versionsListMatch[1]);
    const slug = decodeURIComponent(versionsListMatch[2]);

    const artifact = store.getArtifact(channel, slug);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return true;
    }

    const versions = store.listVersions(channel, slug);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(versions.map(v => ({
      version: v.versionName,
      message: v.message,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
    }))));
    return true;
  }

  // POST /api/channels/:channel/artifacts/:slug/versions - checkpoint
  if (versionsListMatch && req.method === "POST") {
    const channel = decodeURIComponent(versionsListMatch[1]);
    const slug = decodeURIComponent(versionsListMatch[2]);

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { version: versionName, message, createdBy } = JSON.parse(body);
        if (!versionName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "version is required" }));
          return;
        }

        const version = store.createVersion(channel, slug, versionName, message, createdBy || "api");
        if (!version) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Artifact not found" }));
          return;
        }

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          slug,
          version: version.versionName,
          message: version.message,
          createdBy: version.createdBy,
          createdAt: version.createdAt,
        }));
      } catch (e: any) {
        if (e.message?.includes("already exists")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      }
    });
    return true;
  }

  // GET /api/channels/:channel/artifacts/:slug
  const artifactMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && req.method === "GET") {
    const channel = decodeURIComponent(artifactMatch[1]);
    const slug = decodeURIComponent(artifactMatch[2]);

    const artifact = store.getArtifact(channel, slug);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return true;
    }

    // Include versions list per spec
    const versions = store.getVersionNames(channel, slug);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ...formatArtifactResponse(artifact),
      versions,
    }));
    return true;
  }

  // PUT /api/channels/:channel/artifacts/:slug
  if (artifactMatch && req.method === "PUT") {
    const channel = decodeURIComponent(artifactMatch[1]);
    const slug = decodeURIComponent(artifactMatch[2]);

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const ifMatch = req.headers["if-match"];
        const expectedVersion = ifMatch ? parseInt(ifMatch as string) : undefined;

        const artifact = store.updateArtifact(channel, slug, {
          content: data.content,
          tldr: data.tldr,
          title: data.title,
          status: data.status,
          labels: data.labels,
          assignees: data.assignees,
          parentSlug: data.parentSlug,
          orderKey: data.orderKey,
          props: data.props,
          updatedBy: data.updatedBy || "api",
        }, expectedVersion);

        if (!artifact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Artifact not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(formatArtifactResponse(artifact)));
      } catch (e: any) {
        if (e.message?.includes("Version conflict")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      }
    });
    return true;
  }

  // DELETE /api/channels/:channel/artifacts/:slug
  if (artifactMatch && req.method === "DELETE") {
    const channel = decodeURIComponent(artifactMatch[1]);
    const slug = decodeURIComponent(artifactMatch[2]);

    const success = store.deleteArtifact(channel, slug);
    if (!success) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  // GET /api/channels/:channel/artifacts
  const listMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/artifacts$/);
  if (listMatch && req.method === "GET") {
    const channel = decodeURIComponent(listMatch[1]);

    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") as Status | undefined;
    const parentSlugParam = url.searchParams.get("parentSlug");
    const parentSlug = parentSlugParam === "root" ? null : parentSlugParam || undefined;
    const assignee = url.searchParams.get("assignee") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const regex = url.searchParams.get("regex") || undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 10000;
    const offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : 0;

    const artifacts = store.listArtifacts(channel, { type, status, parentSlug, assignee, search, regex, limit, offset });

    // Return summary format per spec (slug, path, type, title, status, tldr, assignees, parentSlug, orderKey)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(artifacts.map(a => ({
      slug: a.slug,
      path: a.path,
      type: a.type,
      title: a.title || null,
      status: a.status,
      tldr: a.tldr,
      assignees: a.assignees || [],
      parentSlug: a.parentSlug || null,
      orderKey: a.orderKey,
      encoding: a.encoding || null,
      contentType: a.contentType || null,
    }))));
    return true;
  }

  // POST /api/channels/:channel/artifacts
  if (listMatch && req.method === "POST") {
    const channel = decodeURIComponent(listMatch[1]);

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        // Validate required fields per spec
        if (!data.slug) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "slug is required" }));
          return;
        }
        if (!data.tldr) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "tldr is required" }));
          return;
        }
        if (!data.type) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "type is required" }));
          return;
        }
        if (!data.content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content is required" }));
          return;
        }

        // Check if slug already exists
        const existing = store.getArtifact(channel, data.slug);
        if (existing) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Artifact with slug '${data.slug}' already exists` }));
          return;
        }

        const artifact = store.createArtifact({
          slug: data.slug,
          channel,
          title: data.title,
          tldr: data.tldr,
          type: data.type,
          content: data.content,
          contentType: data.contentType,
          status: data.status, // Let store.ts handle type-specific defaults
          parentSlug: data.parentSlug,
          labels: data.labels,
          assignees: data.assignees,
          createdBy: data.createdBy || "api",
        });

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(formatArtifactResponse(artifact)));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return true;
  }

  return false;
}

/**
 * Format artifact for REST response - excludes internal id per spec
 */
function formatArtifactResponse(artifact: Artifact): Omit<Artifact, "id"> {
  const { id, ...rest } = artifact;
  return rest;
}

/**
 * Wire artifact SSE events into an existing SSE connection
 * Call this when setting up an SSE stream for a channel
 */
export function wireArtifactSSE(
  channel: string,
  sendEvent: (event: string, data: unknown) => void
): () => void {
  // Subscribe to artifact events
  const unsubArtifacts = store.subscribeToArtifactEvents(channel, (event) => {
    const { id, ...artifact } = event.artifact;
    sendEvent("artifact", {
      action: event.action,
      artifact,
    });
  });

  // Subscribe to version events
  const unsubVersions = store.subscribeToVersionEvents(channel, (event) => {
    sendEvent("artifact_version", event);
  });

  // Return combined unsubscribe function
  return () => {
    unsubArtifacts();
    unsubVersions();
  };
}
