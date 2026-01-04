/**
 * Artifact Types and Storage Interface
 *
 * Persistent artifacts for Cikada channels - specs, tasks, decisions, code.
 * Based on cikada-board-spec.
 */

// =============================================================================
// Core Types
// =============================================================================

export type ArtifactType =
  | "doc"
  | "task"
  | "code"
  | "decision"
  | "knowledgebase"
  | "system.mcp"
  | "system.agent"
  | "system.focus"
  | "system.playbook";

export type ArtifactStatus =
  // Documents
  | "draft"
  | "published"
  | "archived"
  // Tasks
  | "pending"
  | "in_progress"
  | "done"
  | "blocked";

export interface Artifact {
  // Identity
  id: string;
  slug: string;
  channelId: string;

  // Content
  type: ArtifactType;
  title?: string;
  tldr: string;
  content: string;

  // Hierarchy
  parentSlug?: string;
  path: string;

  // Status
  status: ArtifactStatus;
  assignees: string[];
  labels: string[];

  // Versioning
  version: number;

  // Audit
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

// =============================================================================
// Query Types
// =============================================================================

export interface ArtifactFilters {
  type?: ArtifactType;
  status?: ArtifactStatus;
  assignee?: string;
  parentSlug?: string | "root";
  search?: string;
  regex?: string;
  limit?: number;
  offset?: number;
}

export interface ArtifactSummary {
  slug: string;
  path: string;
  type: ArtifactType;
  title?: string;
  status: ArtifactStatus;
  tldr: string;
  assignees: string[];
}

export interface ArtifactTreeNode {
  slug: string;
  path: string;
  type: ArtifactType;
  title?: string;
  status: ArtifactStatus;
  assignees: string[];
  children: ArtifactTreeNode[];
}

// =============================================================================
// CAS (Compare-and-Swap) Types
// =============================================================================

export interface CASChange {
  field: keyof Artifact;
  oldValue: unknown;
  newValue: unknown;
}

export interface CASResult {
  success: boolean;
  artifact?: Artifact;
  conflict?: {
    field: string;
    expected: unknown;
    actual: unknown;
  };
}

// =============================================================================
// Request Types
// =============================================================================

export interface CreateArtifactRequest {
  slug: string;
  type: ArtifactType;
  tldr: string;
  content: string;
  title?: string;
  parentSlug?: string;
  status?: ArtifactStatus;
  assignees?: string[];
  labels?: string[];
  sender: string;
}

export interface UpdateArtifactRequest {
  changes: CASChange[];
  sender: string;
}

// =============================================================================
// Storage Interface
// =============================================================================

export interface ArtifactStorage {
  // Core CRUD
  create(
    artifact: Omit<Artifact, "id" | "version" | "path" | "createdAt" | "updatedAt">
  ): Promise<Artifact>;

  read(channelId: string, slug: string): Promise<Artifact | null>;

  update(
    channelId: string,
    slug: string,
    changes: Partial<Artifact>,
    updatedBy: string
  ): Promise<Artifact>;

  archive(channelId: string, slug: string, updatedBy: string): Promise<void>;

  // Query
  list(channelId: string, filters?: ArtifactFilters): Promise<ArtifactSummary[]>;

  glob(channelId: string, pattern: string): Promise<ArtifactTreeNode[]>;

  // CAS update for multi-agent coordination
  updateWithCAS(
    channelId: string,
    slug: string,
    changes: CASChange[],
    updatedBy: string
  ): Promise<CASResult>;

  // Tree operations
  moveArtifact(
    channelId: string,
    slug: string,
    newParentSlug: string | null,
    updatedBy: string
  ): Promise<Artifact>;

  // Search
  search(channelId: string, query: string, limit?: number): Promise<ArtifactSummary[]>;
}
