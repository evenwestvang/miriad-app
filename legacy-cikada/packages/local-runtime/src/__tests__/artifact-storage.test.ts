/**
 * Artifact Storage Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ArtifactStorage,
  type CreateArtifactInput,
  type CASChange,
  type ArtifactSummary,
  type ArtifactTreeNode,
} from "../artifact-storage.js";

describe("ArtifactStorage", () => {
  let storage: ArtifactStorage;

  beforeEach(() => {
    storage = new ArtifactStorage(":memory:");
  });

  afterEach(() => {
    storage.close();
  });

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  describe("create()", () => {
    it("creates an artifact with required fields", () => {
      const input: CreateArtifactInput = {
        slug: "test-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "A test document",
        content: "# Test\n\nThis is a test.",
        createdBy: "cicada",
      };

      const artifact = storage.create(input);

      expect(artifact.id).toBeDefined();
      expect(artifact.slug).toBe("test-doc");
      expect(artifact.channelId).toBe("channel-1");
      expect(artifact.type).toBe("doc");
      expect(artifact.tldr).toBe("A test document");
      expect(artifact.content).toBe("# Test\n\nThis is a test.");
      expect(artifact.path).toBe("/test-doc");
      expect(artifact.status).toBe("draft");
      expect(artifact.version).toBe(1);
      expect(artifact.createdBy).toBe("cicada");
    });

    it("creates an artifact with optional fields", () => {
      const input: CreateArtifactInput = {
        slug: "api-spec",
        channelId: "channel-1",
        type: "doc",
        title: "API Specification",
        tldr: "REST API spec",
        content: "# API\n\n...",
        status: "published",
        assignees: ["fox", "bear"],
        labels: ["api", "backend"],
        createdBy: "cicada",
      };

      const artifact = storage.create(input);

      expect(artifact.title).toBe("API Specification");
      expect(artifact.status).toBe("published");
      expect(artifact.assignees).toEqual(["fox", "bear"]);
      expect(artifact.labels).toEqual(["api", "backend"]);
    });

    it("computes nested path from parent", () => {
      // Create parent
      storage.create({
        slug: "phase-1",
        channelId: "channel-1",
        type: "task",
        tldr: "Phase 1 tasks",
        content: "",
        createdBy: "cicada",
      });

      // Create child
      const child = storage.create({
        slug: "implement-auth",
        channelId: "channel-1",
        type: "task",
        tldr: "Implement authentication",
        content: "",
        parentSlug: "phase-1",
        createdBy: "cicada",
      });

      expect(child.path).toBe("/phase-1/implement-auth");
    });

    it("extracts refs from content", () => {
      const artifact = storage.create({
        slug: "review-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "Review document",
        content: "Based on [[api-spec]] and [[auth-design]].",
        createdBy: "cicada",
      });

      expect(artifact.refs).toEqual(["api-spec", "auth-design"]);
    });

    it("rejects invalid slug format", () => {
      expect(() =>
        storage.create({
          slug: "Invalid Slug!",
          channelId: "channel-1",
          type: "doc",
          tldr: "Test",
          content: "",
          createdBy: "cicada",
        })
      ).toThrow("Invalid slug format");
    });

    it("rejects duplicate slug in same channel", () => {
      storage.create({
        slug: "unique-slug",
        channelId: "channel-1",
        type: "doc",
        tldr: "First",
        content: "",
        createdBy: "cicada",
      });

      expect(() =>
        storage.create({
          slug: "unique-slug",
          channelId: "channel-1",
          type: "doc",
          tldr: "Second",
          content: "",
          createdBy: "cicada",
        })
      ).toThrow("Artifact already exists");
    });

    it("allows same slug in different channels", () => {
      storage.create({
        slug: "common-slug",
        channelId: "channel-1",
        type: "doc",
        tldr: "Channel 1",
        content: "",
        createdBy: "cicada",
      });

      const artifact2 = storage.create({
        slug: "common-slug",
        channelId: "channel-2",
        type: "doc",
        tldr: "Channel 2",
        content: "",
        createdBy: "cicada",
      });

      expect(artifact2.channelId).toBe("channel-2");
    });

    it("rejects non-existent parent", () => {
      expect(() =>
        storage.create({
          slug: "orphan",
          channelId: "channel-1",
          type: "doc",
          tldr: "Orphan",
          content: "",
          parentSlug: "non-existent",
          createdBy: "cicada",
        })
      ).toThrow("Parent artifact not found");
    });
  });

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  describe("read()", () => {
    it("reads an existing artifact", () => {
      storage.create({
        slug: "my-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "My document",
        content: "Content here",
        createdBy: "cicada",
      });

      const artifact = storage.read("channel-1", "my-doc");

      expect(artifact).not.toBeNull();
      expect(artifact!.slug).toBe("my-doc");
      expect(artifact!.tldr).toBe("My document");
    });

    it("returns null for non-existent artifact", () => {
      const artifact = storage.read("channel-1", "non-existent");
      expect(artifact).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  describe("update()", () => {
    it("updates artifact fields", () => {
      storage.create({
        slug: "mutable-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "Original",
        content: "Original content",
        createdBy: "cicada",
      });

      const updated = storage.update(
        "channel-1",
        "mutable-doc",
        { tldr: "Updated", content: "New content" },
        "fox"
      );

      expect(updated.tldr).toBe("Updated");
      expect(updated.content).toBe("New content");
      expect(updated.version).toBe(2);
      expect(updated.updatedBy).toBe("fox");
      expect(updated.updatedAt).toBeDefined();
    });

    it("increments version on each update", () => {
      storage.create({
        slug: "versioned",
        channelId: "channel-1",
        type: "doc",
        tldr: "v1",
        content: "",
        createdBy: "cicada",
      });

      storage.update("channel-1", "versioned", { tldr: "v2" }, "cicada");
      storage.update("channel-1", "versioned", { tldr: "v3" }, "cicada");
      const artifact = storage.update("channel-1", "versioned", { tldr: "v4" }, "cicada");

      expect(artifact.version).toBe(4);
    });

    it("updates refs when content changes", () => {
      storage.create({
        slug: "refs-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "Refs doc",
        content: "See [[old-ref]]",
        createdBy: "cicada",
      });

      const updated = storage.update(
        "channel-1",
        "refs-doc",
        { content: "See [[new-ref]] and [[another-ref]]" },
        "cicada"
      );

      expect(updated.refs).toEqual(["new-ref", "another-ref"]);
    });

    it("throws on non-existent artifact", () => {
      expect(() =>
        storage.update("channel-1", "ghost", { tldr: "New" }, "cicada")
      ).toThrow("Artifact not found");
    });
  });

  // ---------------------------------------------------------------------------
  // CAS Update
  // ---------------------------------------------------------------------------

  describe("updateWithCAS()", () => {
    it("succeeds when old values match", () => {
      storage.create({
        slug: "cas-doc",
        channelId: "channel-1",
        type: "task",
        tldr: "CAS test",
        content: "",
        status: "pending",
        assignees: [],
        createdBy: "cicada",
      });

      const changes: CASChange[] = [
        { field: "status", oldValue: "pending", newValue: "in_progress" },
        { field: "assignees", oldValue: [], newValue: ["fox"] },
      ];

      const result = storage.updateWithCAS("channel-1", "cas-doc", changes, "fox");

      expect(result.success).toBe(true);
      expect(result.artifact!.status).toBe("in_progress");
      expect(result.artifact!.assignees).toEqual(["fox"]);
    });

    it("fails and returns conflict when value changed", () => {
      storage.create({
        slug: "conflict-doc",
        channelId: "channel-1",
        type: "task",
        tldr: "Conflict test",
        content: "",
        status: "in_progress",
        createdBy: "cicada",
      });

      const changes: CASChange[] = [
        { field: "status", oldValue: "pending", newValue: "done" },
      ];

      const result = storage.updateWithCAS("channel-1", "conflict-doc", changes, "fox");

      expect(result.success).toBe(false);
      expect(result.conflict).toEqual({
        field: "status",
        expected: "pending",
        actual: "in_progress",
      });
    });

    it("fails on first conflict when multiple fields differ", () => {
      storage.create({
        slug: "multi-conflict",
        channelId: "channel-1",
        type: "task",
        tldr: "Multi-conflict test",
        content: "",
        status: "done",
        assignees: ["bear"],
        createdBy: "cicada",
      });

      const changes: CASChange[] = [
        { field: "status", oldValue: "pending", newValue: "in_progress" },
        { field: "assignees", oldValue: [], newValue: ["fox"] },
      ];

      const result = storage.updateWithCAS("channel-1", "multi-conflict", changes, "fox");

      expect(result.success).toBe(false);
      expect(result.conflict!.field).toBe("status");
    });
  });

  // ---------------------------------------------------------------------------
  // Archive
  // ---------------------------------------------------------------------------

  describe("archive()", () => {
    it("sets status to archived", () => {
      storage.create({
        slug: "to-archive",
        channelId: "channel-1",
        type: "doc",
        tldr: "Will be archived",
        content: "",
        createdBy: "cicada",
      });

      storage.archive("channel-1", "to-archive", "cicada");
      const artifact = storage.read("channel-1", "to-archive");

      expect(artifact!.status).toBe("archived");
    });
  });

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  describe("list()", () => {
    beforeEach(() => {
      // Create test data
      storage.create({
        slug: "doc-1",
        channelId: "channel-1",
        type: "doc",
        tldr: "Document 1",
        content: "Content about authentication",
        status: "published",
        createdBy: "cicada",
      });

      storage.create({
        slug: "task-1",
        channelId: "channel-1",
        type: "task",
        tldr: "Task 1",
        content: "",
        status: "pending",
        assignees: ["fox"],
        createdBy: "cicada",
      });

      storage.create({
        slug: "task-2",
        channelId: "channel-1",
        type: "task",
        tldr: "Task 2",
        content: "",
        status: "in_progress",
        assignees: ["bear"],
        createdBy: "cicada",
      });
    });

    it("lists all artifacts in channel", () => {
      const results = storage.list("channel-1");
      expect(results.length).toBe(3);
    });

    it("filters by type", () => {
      const results = storage.list("channel-1", { type: "task" });
      expect(results.length).toBe(2);
      expect(results.every((r: ArtifactSummary) => r.type === "task")).toBe(true);
    });

    it("filters by status", () => {
      const results = storage.list("channel-1", { status: "pending" });
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("task-1");
    });

    it("filters by assignee", () => {
      const results = storage.list("channel-1", { assignee: "fox" });
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("task-1");
    });

    it("excludes archived by default", () => {
      storage.archive("channel-1", "doc-1", "cicada");
      const results = storage.list("channel-1");
      expect(results.length).toBe(2);
    });

    it("includes archived when explicitly filtering", () => {
      storage.archive("channel-1", "doc-1", "cicada");
      const results = storage.list("channel-1", { status: "archived" });
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("doc-1");
    });

    it("supports pagination", () => {
      const page1 = storage.list("channel-1", { limit: 2, offset: 0 });
      const page2 = storage.list("channel-1", { limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // FTS Search
  // ---------------------------------------------------------------------------

  describe("search()", () => {
    beforeEach(() => {
      storage.create({
        slug: "auth-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "Authentication guide",
        content: "How to implement JWT authentication in your app.",
        createdBy: "cicada",
      });

      storage.create({
        slug: "api-doc",
        channelId: "channel-1",
        type: "doc",
        tldr: "API reference",
        content: "REST API endpoints documentation.",
        createdBy: "cicada",
      });
    });

    it("finds artifacts by content keyword", () => {
      const results = storage.search("channel-1", "JWT");
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("auth-doc");
    });

    it("finds artifacts by tldr", () => {
      const results = storage.search("channel-1", "API reference");
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("api-doc");
    });

    it("returns empty for no matches", () => {
      const results = storage.search("channel-1", "nonexistent");
      expect(results.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Glob / Tree
  // ---------------------------------------------------------------------------

  describe("glob()", () => {
    beforeEach(() => {
      // Create tree structure
      storage.create({
        slug: "phase-1",
        channelId: "channel-1",
        type: "task",
        tldr: "Phase 1",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "auth-task",
        channelId: "channel-1",
        type: "task",
        tldr: "Auth task",
        content: "",
        parentSlug: "phase-1",
        createdBy: "cicada",
      });

      storage.create({
        slug: "api-task",
        channelId: "channel-1",
        type: "task",
        tldr: "API task",
        content: "",
        parentSlug: "phase-1",
        createdBy: "cicada",
      });

      storage.create({
        slug: "standalone",
        channelId: "channel-1",
        type: "doc",
        tldr: "Standalone doc",
        content: "",
        createdBy: "cicada",
      });
    });

    it("returns all artifacts with /**", () => {
      const tree = storage.glob("channel-1", "/**");
      expect(tree.length).toBe(2); // phase-1 and standalone at root

      const phase1 = tree.find((n: ArtifactTreeNode) => n.slug === "phase-1");
      expect(phase1).toBeDefined();
      expect(phase1!.children.length).toBe(2);
    });

    it("returns root level only with /*", () => {
      const tree = storage.glob("channel-1", "/*");
      expect(tree.length).toBe(2); // phase-1 and standalone
      // Children should not be included in root-only query
    });

    it("builds correct tree structure", () => {
      const tree = storage.glob("channel-1", "/**");

      const phase1 = tree.find((n: ArtifactTreeNode) => n.slug === "phase-1")!;
      expect(phase1.children.map((c: ArtifactTreeNode) => c.slug).sort()).toEqual(["api-task", "auth-task"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Parent Change / Path Cascade
  // ---------------------------------------------------------------------------

  describe("parentSlug changes", () => {
    it("updates path when parent changes", () => {
      storage.create({
        slug: "old-parent",
        channelId: "channel-1",
        type: "task",
        tldr: "Old parent",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "new-parent",
        channelId: "channel-1",
        type: "task",
        tldr: "New parent",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "movable",
        channelId: "channel-1",
        type: "task",
        tldr: "Movable task",
        content: "",
        parentSlug: "old-parent",
        createdBy: "cicada",
      });

      // Move to new parent
      const moved = storage.update(
        "channel-1",
        "movable",
        { parentSlug: "new-parent" },
        "cicada"
      );

      expect(moved.path).toBe("/new-parent/movable");
    });

    it("cascades path updates to descendants", () => {
      storage.create({
        slug: "root-1",
        channelId: "channel-1",
        type: "task",
        tldr: "Root 1",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "root-2",
        channelId: "channel-1",
        type: "task",
        tldr: "Root 2",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "parent",
        channelId: "channel-1",
        type: "task",
        tldr: "Parent",
        content: "",
        parentSlug: "root-1",
        createdBy: "cicada",
      });

      storage.create({
        slug: "child",
        channelId: "channel-1",
        type: "task",
        tldr: "Child",
        content: "",
        parentSlug: "parent",
        createdBy: "cicada",
      });

      // Move parent to root-2
      storage.update("channel-1", "parent", { parentSlug: "root-2" }, "cicada");

      const child = storage.read("channel-1", "child");
      expect(child!.path).toBe("/root-2/parent/child");
    });

    it("detects and prevents cycles", () => {
      storage.create({
        slug: "a",
        channelId: "channel-1",
        type: "task",
        tldr: "A",
        content: "",
        createdBy: "cicada",
      });

      storage.create({
        slug: "b",
        channelId: "channel-1",
        type: "task",
        tldr: "B",
        content: "",
        parentSlug: "a",
        createdBy: "cicada",
      });

      storage.create({
        slug: "c",
        channelId: "channel-1",
        type: "task",
        tldr: "C",
        content: "",
        parentSlug: "b",
        createdBy: "cicada",
      });

      // Try to make A a child of C (would create cycle: A -> B -> C -> A)
      expect(() =>
        storage.update("channel-1", "a", { parentSlug: "c" }, "cicada")
      ).toThrow("would create cycle");
    });

    it("prevents self-parenting", () => {
      storage.create({
        slug: "self",
        channelId: "channel-1",
        type: "task",
        tldr: "Self",
        content: "",
        createdBy: "cicada",
      });

      expect(() =>
        storage.update("channel-1", "self", { parentSlug: "self" }, "cicada")
      ).toThrow("would create cycle");
    });
  });
});
