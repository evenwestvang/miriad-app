# Complete PowPow Prompt Extraction

Everything needed to replicate the PowPow agent experience, organized into parts:

## Contents

1. **[01-tools.md](./01-tools.md)** — All MCP tool descriptions exactly as agents see them
2. **[02-system-instructions.md](./02-system-instructions.md)** — Channel participation instructions injected into every agent
3. **[03-agents-core.md](./03-agents-core.md)** — Core workflow agents (Lead, Builder, Researcher, Reviewer, Scout, Steward, Custodian, Tester)
4. **[04-agents-design.md](./04-agents-design.md)** — Design agents (UX Designer, AX Designer, Info Architect, Web Designer)
5. **[05-agents-content.md](./05-agents-content.md)** — Content agents (Content Writer, Creative Writer, Technical Writer, Content Modeler, Illustrator)
6. **[06-agents-specialty.md](./06-agents-specialty.md)** — Specialty agents (KB Manager, Librarian, Contrarian, Commodore Coder)
7. **[07-playbooks.md](./07-playbooks.md)** — All playbook content
8. **[08-focus-types.md](./08-focus-types.md)** — Focus type configurations

---

## How This System Works

### Agent Prompt Assembly

When an agent joins a channel, their full context is assembled from:

1. **Role prompt** — From `system.agent` artifact content field
2. **Channel participation** — Standard instructions about messaging, artifacts, coordination
3. **Channel context** — Channel name, tagline, mission, roster
4. **Initial task** — From focus type's `initialPrompt` or custom

### Tool Access

Agents see tools based on:
1. **Core PowPow tools** — All agents get these (artifacts, messaging, KB)
2. **MCP server assignments** — From `props.mcp` in agent definition

### Coordination Primitives

- **Compare-and-swap** — Atomic task claiming via `artifact_update`
- **@mentions** — Explicit notification routing
- **Board as truth** — Artifacts are the shared state
- **Playbooks** — Explicit protocols copied from #root

---

## Agent Summary

| Agent | Slug | Engine | Name Theme | MCP Servers |
|-------|------|--------|------------|-------------|
| Lead | `lead` | claude | (fixed) | - |
| Builder | `builder` | claude | nato-alphabet | agentibility, sanity, vision |
| Researcher | `researcher` | claude | greek-alphabet | - |
| Reviewer | `reviewer` | claude | gemstones | - |
| Scout | `scout` | claude | animals | - |
| Steward | `steward` | claude | (fixed) | - |
| Custodian | `custodian` | claude | (fixed) | - |
| Tester | `tester` | claude | birds | agentibility |
| UX Designer | `ux-designer` | claude | colors | vision |
| AX Designer | `ax-designer` | claude | colors | - |
| Info Architect | `infoarchitect` | claude | cartographers | - |
| Web Designer | `webdesigner` | claude | artists | agentibility, sanity, vision |
| Content Writer | `contentwriter` | claude | literary-figures | - |
| Creative Writer | `creativewriter` | claude | trees | - |
| Technical Writer | `technicalwriter` | claude | scientists | - |
| Content Modeler | `contentmodeler` | claude | philosophers | sanity |
| Illustrator | `illustrator` | claude | painters | sanity, agentibility, vision |
| KB Manager | `kbmanager` | claude | dinosaurs | - |
| Librarian | `librarian` | claude | archivists | - |
| Contrarian | `contrarian` | codex | flowers | - |
| Commodore Coder | `commodorecoder` | claude | cities | vice |

---

## Focus Types Summary

| Focus | Default Agents | Initial Prompt Theme |
|-------|----------------|---------------------|
| Open | lead | Freeform exploration |
| Marketing | lead, creativewriter | Audience and action |
| Strategy | lead, researcher, contrarian | Context and constraints |
| Content Ops | lead, contentmodeler, technicalwriter, contentwriter | Content challenge |
| Research | lead, researcher, infoarchitect | Research questions |
| Proposal | lead, creativewriter, researcher | Audience persuasion |
| Editorial | lead, creativewriter, illustrator | Story angle |
| Brainstorm | lead, creativewriter, contrarian | Challenge and options |
