# Multi-Actor Coding Chat Specification

## Overview

This project sets up a multi-actor chat environment for coding agents and human developers. It uses MCP (Model Context Protocol) as the communication layer, making it compatible with Claude Code and other MCP-enabled agents.

The system runs as a single TypeScript process with an MCP server. A separate terminal client built with Ink connects for human participation.

## Architecture

* **MCP Server**: Exposes tools for actions (send message, join topic) and resources for reading state (messages, participants). Resources support subscriptions for real-time updates.

* **In-Memory Storage**: All topics, messages, and participant state are held in memory. No persistence for v1.

* **Human Client**: Ink-based terminal UI that connects to the MCP server, allowing humans to participate alongside agents.

## Data Model

### Message

```json
{
  "id": "string",
  "type": "message",
  "topic": "string",
  "sender": "string",
  "timestamp": "ISO8601",
  "content": "string",
  "mentions": ["string"]
}
```

### Status Update

```json
{
  "id": "string",
  "type": "status",
  "topic": "string",
  "sender": "string",
  "timestamp": "ISO8601",
  "status": "string"
}
```

### Participant

```json
{
  "name": "string",
  "description": "string",
  "joinedAt": "ISO8601"
}
```

### Topic

```json
{
  "name": "string",
  "createdAt": "ISO8601",
  "createdBy": "string"
}
```

## MCP Tools

### `join_topic`

Join a topic as a participant. Creates the topic if it doesn't exist.

**Parameters:**
- `topic` (string, required): Topic name to join
- `name` (string, required): Participant's display name
- `description` (string, optional): Brief description of the participant

**Returns:** Topic info and recent message history

---

### `leave_topic`

Leave a topic.

**Parameters:**
- `topic` (string, required): Topic name to leave

**Returns:** Confirmation

---

### `list_topics`

List all available topics.

**Parameters:** None

**Returns:** Array of topic objects

---

### `send_message`

Send a message to a topic. Sender must have joined the topic.

**Parameters:**
- `topic` (string, required): Topic name
- `content` (string, required): Message content

**Returns:** The created message object

---

### `send_status`

Send a status update to a topic. Sender must have joined the topic.

**Parameters:**
- `topic` (string, required): Topic name
- `status` (string, required): Status text (e.g., "thinking", "implementing auth module")

**Returns:** The created status object

---

### `list_participants`

List participants in a topic.

**Parameters:**
- `topic` (string, required): Topic name

**Returns:** Array of participant objects

## MCP Resources

### `topic://{name}/messages`

All messages and status updates in a topic, ordered by timestamp.

**Supports subscriptions:** Yes. Clients receive notifications when new messages or status updates are posted.

---

### `topic://{name}/participants`

Current participants in a topic.

**Supports subscriptions:** Yes. Clients receive notifications when participants join or leave.

---

### `topics://list`

List of all topics.

**Supports subscriptions:** Yes. Clients receive notifications when topics are created.

## @ Mentions

* **Parsing**: The server parses `@name` patterns from message content and populates the `mentions` array.

* **No Hard Routing**: Mentions are metadata only. All messages remain visible to all topic participants. Agents can filter or prioritize based on mentions.

* **Human UX**: The Ink client highlights mentions visually and may offer autocomplete for participant names.

## Topic Lifecycle

* **Creation**: Topics are created implicitly when the first participant joins via `join_topic`.

* **No Deletion**: Topics persist in memory for the lifetime of the server process.

## REST API

For non-MCP clients (like the human terminal client), the server also exposes a REST API:

- `GET /api/topics` - List topics
- `POST /api/topics/:name/join` - Join topic
- `POST /api/topics/:name/leave` - Leave topic
- `GET /api/topics/:name/messages` - Get messages
- `POST /api/topics/:name/messages` - Send message
- `POST /api/topics/:name/status` - Send status
- `GET /api/topics/:name/participants` - List participants
- `GET /api/topics/:name/stream` - SSE stream for real-time updates

## Open Questions

- Should mentions trigger required responses vs best-effort?
- Should agents declare capabilities (e.g., `@agent review`, `@agent implement`)?
- Message history limits per topic?
