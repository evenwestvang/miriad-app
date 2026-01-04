/**
 * SPIKE: Artifact REST Endpoints
 *
 * This file contains the REST endpoint handlers for the artifact system.
 * To integrate: add these route handlers to the httpServer in src/server/index.ts
 *
 * Dependencies:
 * - store artifact methods from store.ts
 * - Artifact type from store.ts
 */

/**
 * REST Endpoint Handlers
 *
 * Add these to the httpServer request handler in src/server/index.ts
 * after the existing channel endpoints.
 */

// GET /api/channels/:channel/artifacts - List artifacts
const listArtifactsHandler = `
  // GET /api/channels/:channel/artifacts - list artifacts
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts$/) && req.method === "GET") {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const assignee = url.searchParams.get("assignee") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "50");

    const artifacts = store.listArtifacts(channelName, { type, status, assignee, limit });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(artifacts));
    return;
  }
`;

// GET /api/channels/:channel/artifacts/:name - Get single artifact
const getArtifactHandler = `
  // GET /api/channels/:channel/artifacts/:name - get artifact
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts\\/[^/]+$/) && req.method === "GET") {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const artifactName = decodeURIComponent(parts[5]);

    const artifact = store.getArtifact(channelName, artifactName);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(artifact));
    return;
  }
`;

// POST /api/channels/:channel/artifacts - Create artifact
const createArtifactHandler = `
  // POST /api/channels/:channel/artifacts - create artifact
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts$/) && req.method === "POST") {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data.name || !data.type || !data.content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "name, type, and content required" }));
          return;
        }

        // Check if artifact already exists
        const existing = store.getArtifact(channelName, data.name);
        if (existing) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Artifact already exists. Use PUT to update." }));
          return;
        }

        const artifact = store.createOrUpdateArtifact({
          channel: channelName,
          name: data.name,
          type: data.type,
          content: data.content,
          status: data.status || "published",
          taskStatus: data.taskStatus,
          labels: data.labels,
          assignees: data.assignees,
          parentId: data.parentId,
          messageRef: data.messageRef,
          createdBy: data.createdBy || "api",
        });

        console.error(\`[powpow] Created artifact: \${channelName}/\${data.name}\`);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(artifact));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
`;

// PUT /api/channels/:channel/artifacts/:name - Update artifact
const updateArtifactHandler = `
  // PUT /api/channels/:channel/artifacts/:name - update artifact
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts\\/[^/]+$/) && req.method === "PUT") {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const artifactName = decodeURIComponent(parts[5]);

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        // Check version for optimistic locking if provided
        const ifMatch = req.headers["if-match"];
        if (ifMatch) {
          const existing = store.getArtifact(channelName, artifactName);
          if (existing && existing.version !== parseInt(ifMatch)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Version conflict",
              currentVersion: existing.version,
              requestedVersion: parseInt(ifMatch),
            }));
            return;
          }
        }

        const artifact = store.updateArtifact(channelName, artifactName, {
          content: data.content,
          status: data.status,
          taskStatus: data.taskStatus,
          labels: data.labels,
          assignees: data.assignees,
          updatedBy: data.updatedBy || "api",
        });

        if (!artifact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Artifact not found" }));
          return;
        }

        console.error(\`[powpow] Updated artifact: \${channelName}/\${artifactName}\`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(artifact));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
`;

// DELETE /api/channels/:channel/artifacts/:name - Delete artifact (admin only)
const deleteArtifactHandler = `
  // DELETE /api/channels/:channel/artifacts/:name - delete artifact (hard delete)
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts\\/[^/]+$/) && req.method === "DELETE") {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const artifactName = decodeURIComponent(parts[5]);

    const success = store.deleteArtifact(channelName, artifactName);
    if (!success) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return;
    }

    console.error(\`[powpow] Deleted artifact: \${channelName}/\${artifactName}\`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: \`Deleted \${artifactName}\` }));
    return;
  }
`;

// POST /api/channels/:channel/artifacts/:name/archive - Archive artifact
const archiveArtifactHandler = `
  // POST /api/channels/:channel/artifacts/:name/archive - archive artifact
  if (url.pathname.match(/^\\/api\\/channels\\/[^/]+\\/artifacts\\/[^/]+\\/archive$/) && req.method === "POST") {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const artifactName = decodeURIComponent(parts[5]);

    const success = store.archiveArtifact(channelName, artifactName, "api");
    if (!success) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Artifact not found" }));
      return;
    }

    console.error(\`[powpow] Archived artifact: \${channelName}/\${artifactName}\`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: \`Archived \${artifactName}\` }));
    return;
  }
`;

/**
 * Integration instructions:
 *
 * Add these handlers to src/server/index.ts inside the httpServer request handler,
 * BEFORE the 404 handler at the end.
 *
 * Order matters for regex matching - more specific routes should come first.
 * Recommended order:
 * 1. archiveArtifactHandler (has /archive suffix)
 * 2. getArtifactHandler, updateArtifactHandler, deleteArtifactHandler (specific artifact)
 * 3. listArtifactsHandler, createArtifactHandler (artifact collection)
 */

export const allHandlers = `
${archiveArtifactHandler}

${getArtifactHandler}

${updateArtifactHandler}

${deleteArtifactHandler}

${listArtifactsHandler}

${createArtifactHandler}
`;

console.log("REST endpoint handlers ready for integration");
console.log("Copy the handlers from this file into src/server/index.ts");
