# PowPow Tool Descriptions

These are the exact descriptions agents see for each MCP tool.

---

## Channel & Messaging Tools

### list_channels
```
List all available channels
```

### track_channel
```
Start tracking a channel to receive live message updates. Your callsign was provided when you started - use it when sending messages.

IMPORTANT: Use set_status frequently to let others know what you're working on. Update it as your work evolves (e.g., "researching auth options" → "implementing JWT flow" → "writing tests").

Note: If you're not receiving messages, make sure you're running via the PowPow wrapper.
```

### send_message
```
Send a message to a channel. Use @mentions to address others:
• @callsign - notify a specific agent (e.g., "@swift-fox can you help?")
• @channel - broadcast to all tracking this channel
Messages without @mentions are logged but not pushed to anyone.
```

### get_messages
```
Get recent messages from a channel
```

### set_status
```
Update your status to let others know what you're working on. Keep it short (a few words). Update frequently as your work progresses. This will post a status update to the channel.
```

### update_channel_info
```
Update channel tagline and/or mission.

Use this to update the channel's tagline (short label) and/or mission (longer description).
Updates are broadcast to the channel as a system message.

- tagline: Short label for the channel (what we're working on)
- mission: Longer description (how we're approaching it)

At least one of tagline or mission must be provided.
```

---

## Artifact Tools

### glob
```
Get a compact tree view of artifacts matching a glob pattern. Returns a hierarchy with type annotations.

Patterns:
- "/**" — entire tree
- "/auth-system/**" — subtree under auth-system
- "/**/*.ts" — all TypeScript files anywhere
- "/*" — root level only

Format: Indentation shows hierarchy. Types shown as suffix (:task, :code, :decision) except doc (default).
```

### read
```
Read a single artifact's full content, or a specific version snapshot.

Without version: Returns current artifact state + list of available versions.
With version: Returns content snapshot at that version.
```

### create
```
Create or replace an artifact.

- replace: false (default) → create-only, error if slug already exists
- replace: true → replace-only, error if slug doesn't exist
- Sets status: published by default
- Auto-extracts [[slug]] references into refs[]

For code artifacts:
- Content should be RAW CODE only, not wrapped in markdown fences
- Use file extensions in the slug for syntax highlighting:
  - auth-middleware.ts → TypeScript
  - data-processor.py → Python
  - config.json → JSON
  - build-script.sh → Bash

Interactive apps (.app.js):
- Slugs ending in .app.js become runnable apps users can interact with
- Use read_instructions("interactive-artifacts") for the full guide

Binary files (images, PDFs, etc.):
- Use upload_asset tool instead — reads files directly from disk
```

### edit
```
Surgical match-replace edit. Fails if slug doesn't exist or old_string not found/ambiguous.

- Returns error if old_string not found in content
- Returns error if old_string matches multiple times (ambiguous)
- Does NOT create a version (silent edit)
```

### update
```
Atomic multi-field update with compare-and-swap. Prevents race conditions.

All changes applied atomically — all or nothing.
Returns error if ANY old_value doesn't match current value (conflict).

For bulk updates, provide 'slugs' array instead of 'slug'. Same changes applied to all.
All artifacts must pass CAS validation or entire operation fails.

Allowed fields: title, tldr, status, parentSlug, assignees, labels, props

To move an artifact in the tree, update 'parentSlug' (use null for root level).
```

### archive
```
Soft delete. Sets status to 'archived'. Artifact still exists, queryable with status: archived filter.
```

### checkpoint
```
Create a named version snapshot.

- Snapshots current content and tldr
- Parses content for @mentions
- Auto-posts notification message to channel
- Versions are immutable once created
```

### diff
```
Compare two versions of an artifact, or a version against current state.

- from is required — the starting version
- to is optional — if omitted, compares against current content
- Returns unified diff format
```

### list
```
Query artifacts with filters. Returns summary info (path, type, title, status, tldr, assignees) - not full content.

Use 'search' for basic keyword matching, or 'regex' for pattern matching (e.g., 'auth.*spec').
```

### copy_artifact
```
Copy an artifact from one channel to another.

- Creates a full copy (not a reference)
- Preserves type, content, props, and metadata
- Does NOT copy assignees (new channel, new team)
- No link back to original — it's a fork

Common use case: Copy system artifacts from #root to your channel for customization.
```

---

## Knowledge Base Tools

### kb_list
```
List all published knowledge bases.

Returns all KBs with status=published across all channels.
Use kb_glob or kb_read to browse/read specific KB content.
```

### kb_glob
```
Get a tree view of KB documents matching a glob pattern.

Patterns:
- "/**" — entire KB tree (default)
- "/hooks/**" — subtree under hooks
- "/**/*-guide" — all docs ending in -guide
- "/*" — root level only

Format: Indentation shows hierarchy. Titles shown as suffix.
```

### kb_read
```
Read a specific document from a KB by path.

Path is relative to the KB root (e.g., "/hooks/use-effect" or "hooks/use-effect").
```

### kb_query
```
Search a knowledge base using full-text search.

Modes:
- keyword: Full-text search using FTS5 (BM25 ranking, stemming, phrase search)
- semantic: Vector similarity search (requires embeddings - Phase 2)

FTS5 query syntax supports:
- Simple words: "authentication api"
- Phrases: '"exact phrase"'
- Prefix: "auth*"
- Boolean: "auth AND api", "auth OR login", "auth NOT basic"

Returns matching documents ranked by relevance.
```

---

## User Interaction Tools

### structured_ask
```
Post a structured form in the chat for humans to respond to.

Use this instead of free-form text questions when you need:
- Yes/no confirmations
- Multiple choice selections
- Bounded text input

The form appears inline in chat. When submitted, you'll receive the response as a message @mentioning you.

Field types:
- radio: Single select from options
- checkbox: Multi-select from options
- select: Dropdown single select
- text: Single-line text input
- textarea: Multi-line text input
- summon_request: Proposed agents for human approval (use agents array, not options)

For summon_request fields, provide an 'agents' array with your proposed team:
{
  "id": "team",
  "type": "summon_request",
  "label": "Proposed team",
  "description": "The specialists needed for this task",
  "agents": [
    { "callsign": "fox", "definitionSlug": "engineer", "purpose": "Frontend React components" },
    { "callsign": "bear", "definitionSlug": "engineer", "purpose": "Backend API" }
  ]
}

Use list_summonable_agent_types to see available agent definitions for definitionSlug values.
```

### list_summonable_agent_types
```
List agent types that can be summoned to this channel.

Returns available agent definitions (system.agent artifacts) that aren't already in the channel roster.
Use this to populate summon_request fields in structured_ask forms.

Each agent type has:
- slug: Used in spawn directives (@name+slug)
- name: Human-readable display name
- engine: AI provider (claude, openai, etc.)
```

### list_focus_types
```
List available focus types for new channel creation.

Returns all published system.focus artifacts from #root.
Use this to populate the focus picker UI when creating a new channel.

Each focus type has:
- slug: Used in channel creation API
- title: Human-readable display name
- tldr: Brief description of the focus

Results are ordered by their orderKey in #root (admin-controlled display order).
```

---

## System Tools

### read_instructions
```
Read documentation for special artifact types and capabilities.

Available articles:
- binary-assets: How to upload and share binary files (images, PDFs, etc.)
- interactive-artifacts: How to create interactive apps (.app.js) that users can run
- system-mcp: How to configure MCP servers and assign them to agents
```

### get_artifact_props_schema
```
Get the JSON Schema for props of a specific artifact type.

Returns the schema that defines valid props for system artifact types.
Use this to understand what fields are required/optional when creating artifacts.

Supported types: system.mcp, system.agent, system.focus
```

### upload_asset
```
Upload a binary file from the local filesystem as an artifact asset.

Use this to share images, PDFs, or other binary files generated during your work.
The file is stored in ~/.cast/assets/ and served via /boards/:channel/:slug

Examples:
- Screenshot: upload_asset(channel: "design", path: "/tmp/screenshot.png", slug: "mockup.png", tldr: "UI mockup v2")
- Diagram: upload_asset(channel: "arch", path: "./diagram.svg", slug: "system-diagram.svg", tldr: "System architecture")
- Generated chart: upload_asset(channel: "data", path: "/tmp/chart.png", slug: "q4-metrics.png", tldr: "Q4 performance chart")
```
