# Playbooks

Complete content for all system playbooks. These are copied to channels and customized for specific projects.

---

## Git Workflow

**Slug:** `git-workflow`
**TL;DR:** Guidelines for working with git in feature branches, protecting main, and coordinating merges in team sessions.

### Full Content

```markdown
# Git Workflow

## Feature Branch Model

All work happens in feature branches, not directly on main. This keeps main stable and makes collaboration cleaner.

### Basic Flow

1. Create a feature branch from main: `git checkout -b feature/my-feature`
2. Commit work incrementally with clear messages
3. Push to remote regularly to share progress
4. When complete, request merge to main

## ⚠️ Protected Main Branch

**Pushing to main requires explicit instruction from a human.**

Do not:
- Commit directly to main
- Merge to main without approval
- Push to main assuming it's okay

If you're unsure whether to merge to main, ask. Default to keeping work in the feature branch until given the green light.

## Team Sessions: Sub-Branches

When multiple agents work on a feature together, use sub-branches to avoid conflicts.

> 📋 **Document your setup.** Create a project playbook in your channel with repo URL, branch names, and key files. See [[channel-playbook-example]] for a template.

```
main
  └── feature/auth-system        ← main feature branch
        ├── auth-system/fox      ← agent sub-branch
        ├── auth-system/bear     ← agent sub-branch
        └── auth-system/owl      ← agent sub-branch
```

### How It Works

1. Each agent works in their own sub-branch off the feature branch
2. Agents commit and push to their sub-branch freely
3. A **steward** manages merging sub-branches into the feature branch
4. Only the steward (or explicit instruction) merges feature → main

### Summoning a Steward

For big team sessions, consider summoning a dedicated steward agent to:
- Monitor sub-branch progress
- Resolve merge conflicts
- Keep the feature branch integrated and healthy
- Coordinate the final merge to main

This frees other agents to focus on implementation without merge coordination overhead.

## Commit Messages

Keep them clear and concise:
- Start with a verb: "Add", "Fix", "Update", "Remove"
- Describe what changed and why if not obvious
- Reference related artifacts or tasks when relevant

## Quick Reference

| Action | Command |
|--------|---------|
| Create feature branch | `git checkout -b feature/name` |
| Create sub-branch | `git checkout -b feature/name/callsign` |
| Check current branch | `git branch --show-current` |
| Push branch | `git push -u origin branch-name` |
| Switch branches | `git checkout branch-name` |
```

---

## Rapid Prototyping

**Slug:** `rapid-prototyping`
**TL;DR:** Guidelines for fast-moving early-stage work where velocity matters more than ceremony. When to work directly on main and skip the usual overhead.

### Full Content

```markdown
# Rapid Prototyping

Sometimes you need to move fast. New projects, spikes, throwaway experiments—these don't need the full ceremony of feature branches, PRs, and formal reviews.

## When This Applies

Use rapid prototyping mode when:

- **Greenfield projects** — Nothing exists yet. You're establishing foundations, not protecting a working system.
- **Solo or tiny team** — One or two people exploring. No merge conflicts, no coordination overhead.
- **Spikes and experiments** — Throwaway code to validate an idea. If it works, you'll rewrite it properly.
- **Time-boxed exploration** — "Let's see if this is even possible" work with a clear deadline.
- **Pre-users** — No one depends on this yet. Breaking things has no cost.

## When This Does NOT Apply

Switch to the standard git workflow when:

- Multiple agents working in parallel (use feature branches)
- Users or other systems depend on the code
- The project has graduated from prototype to product
- You're told to follow the git-workflow playbook

## Working in Rapid Mode

### Commit directly to main
Skip branches. Push to main. Keep momentum.

### Keep commits atomic
Fast doesn't mean sloppy. Each commit should still be a coherent change. If something breaks, you want to know which commit did it.

### Stay clean enough
- Delete dead code as you go
- Keep files organized
- Write just enough comments to remember what you were thinking

### Know when to stop
Rapid mode is temporary. When the prototype proves out and becomes real, pause and set up proper structure:
- Establish the git workflow
- Create a feature branch for ongoing work
- Document what you built

## The Mindset

Rapid prototyping is about learning fast, not building fast. The goal is to answer questions:
- Does this approach work?
- Is this library suitable?
- Can we build this at all?

Once you have answers, slow down and build it right.
```

---

## Testing

**Slug:** `testing`
**TL;DR:** Testing strategy for agentic workflows. Emphasizes early harnesses, user-facing interface testing, and catching the gap between "code works" and "user can use it."

### Full Content

```markdown
# Testing

Test coverage is paramount in fast-moving agentic workflows. Agents work quickly but can't easily exercise systems the way humans do. Good testing infrastructure pays for itself immediately.

## Why This Matters for Agents

Agents face unique testing challenges:

- **Can't easily click around** — Manual exploration that humans do naturally is cumbersome for agents.
- **Perfect code, invisible features** — Agents often write flawless implementations that aren't actually exposed to users through the UI or CLI.
- **Fast iteration, fast breakage** — Speed means more opportunities for regressions.

Testing isn't just about correctness—it's about ensuring what's built is actually usable.

## The Testing Pyramid

### Unit Tests
The foundation. Test individual functions and modules in isolation.
- Fast to write, fast to run
- Catch logic errors early
- Every agent can write these as they code

### Integration Tests
Test components working together.
- Verify APIs connect properly
- Test database interactions
- Catch interface mismatches

### End-to-End Tests
**Critical for agentic workflows.** Test the system through user-facing interfaces.
- Use the CLI the user will use
- Drive the UI the user will see
- Call the API endpoints users will hit

If end-to-end tests pass, users can actually use the feature. If they fail, something is broken in the chain from code to user.

## Get Harnesses Up Early

Don't wait until "the code is done" to build test infrastructure.

### Simulations
Mock external services early. Don't let third-party APIs block testing.
- Stub payment providers, auth services, external APIs
- Make them configurable: happy path, error cases, edge cases
- Run tests without network dependencies

### Test Harnesses
Build scaffolding that exercises your system:
- CLI test runners that invoke commands and check output
- API test clients that hit endpoints programmatically
- UI automation if applicable (Playwright, Cypress, etc.)

**Set these up at project start, not project end.** Early investment saves enormous time later.

## Test Through User Interfaces

This is the most common gap in agentic development: code that works perfectly but isn't accessible to users.

### The Problem
```
✓ Function works
✓ API endpoint works
✗ CLI command doesn't call the endpoint
✗ User can't access the feature
```

### The Solution
Write integration tests that use the same interfaces users will:

- **CLI projects** — Tests should invoke the actual CLI binary
- **Web apps** — Tests should drive the browser or call REST endpoints
- **Libraries** — Tests should import and use the public API

If you test `myFunction()` directly but users access it through `mycli run`, you've tested the wrong thing.

## What to Test

Prioritize by user impact:

1. **Critical paths** — The main things users do. If these break, the product is broken.
2. **Error handling** — What happens when things go wrong? Users will find out.
3. **Edge cases** — Boundaries, empty states, large inputs.
4. **Regressions** — When you fix a bug, add a test so it stays fixed.

## Test Continuously

- Run tests on every commit
- Don't merge red builds
- Fix flaky tests immediately—they erode trust in the suite

## Quick Start for New Projects

1. **Day 1**: Set up test framework, write first unit test
2. **Day 1**: Create test harness for primary user interface (CLI wrapper, API client)
3. **Week 1**: Add integration test that exercises a full user flow
4. **Ongoing**: Every feature gets tests at all levels

Don't defer testing infrastructure. The time you "save" now costs 10x later.
```

---

## Channel Playbook Example

**Slug:** `channel-playbook-example`
**TL;DR:** Template for project-specific channel playbooks. Copy to your channel and fill in the details.

### Full Content

```markdown
# Project Playbook Template

Copy this to your channel as `project-playbook` and fill in the sections relevant to your work.

---

## Project Overview

_One paragraph describing what this project is about and what we're building._

## Repository

- **Repo**: `org/repo-name`
- **Clone URL**: `https://github.com/org/repo-name`
- **Feature branch**: `feature/your-feature`
- **Base branch**: `main`

## Branch Strategy

```
main
  └── feature/your-feature         ← main feature branch
        ├── your-feature/fox       ← agent sub-branch
        ├── your-feature/bear      ← agent sub-branch
        └── your-feature/owl       ← agent sub-branch
```

- Work in your sub-branch (`your-feature/{callsign}`)
- Push frequently
- Coordinate merges to feature branch via steward or lead
- **Do not push to main** without explicit approval

## Key Files

_List the main files agents will be working with. Group by area if helpful._

**Backend:**
- `src/...` - Description

**Frontend:**
- `src/...` - Description

## Tasks

_Reference your task tree here._

See [[main-task]] for the breakdown:
- [[subtask-1]] - Description
- [[subtask-2]] - Description

## Important Notes

_Project-specific gotchas, constraints, or things agents should know._

- Example: "Don't modify X without checking Y first"
- Example: "Config is loaded at startup, restart required for changes"

## Testing

_How to test changes in this project._

- Unit tests: `npm test`
- Integration: `npm run test:integration`
- Manual testing notes
```

---

## Knowledge Base Playbook

**Slug:** `kb-playbook`
**TL;DR:** Comprehensive playbook for building knowledge bases—from source mapping through structure design to dense, agent-optimized content.

### Full Content

```markdown
# Knowledge Base Playbook

A complete guide for building knowledge bases (KBs)—structured, searchable reference collections designed to make AI agents experts in any domain.

---

## What Makes a Great KB

A KB isn't documentation. It's **concentrated intelligence**—hyper-compact dossiers that fill knowledge gaps for already-smart agents.

**Great KBs are:**
- **Dense** — Facts, specs, examples. No filler.
- **Structured** — Logical hierarchy that matches how the domain works
- **Searchable** — Full-text and semantic search across all content
- **Agent-optimized** — Assumes intelligence, provides specifics
- **Cross-referenced** — Rich links between related concepts

**Great KBs are NOT:**
- Tutorial-style hand-holding
- Prose where tables would be clearer
- Repetition of basics across articles
- Vague generalities without specifics

---

## Phase 1: Source Mapping

Before writing anything, map the territory.

### Survey the Domain
- What authoritative sources exist?
- Where do experts go for reference?
- What's well-documented vs poorly-documented?
- What gotchas do practitioners know but docs don't capture?

### Build a Source Inventory
Create a sources artifact on the board:
- Primary sources (official docs, specs, standards)
- Secondary sources (community resources, tutorials, blogs)
- Tools and references (API explorers, cheat sheets)
- Vintage/archival sources if applicable

### Identify Gaps
- What's missing from existing documentation?
- What questions do people repeatedly ask?
- What's scattered across multiple sources that should be unified?

**Deliverable:** Source inventory artifact with curated, prioritized resources.

---

## Phase 2: Structure Workshop

Design the tree before creating content. Structure is hard to change later.

### Draft the Hierarchy
- Map out all topics and subtopics
- Group by concept, not by source
- Keep depth reasonable (2-4 levels typically)
- Ensure logical navigation paths

### Structure Principles

**Mutual Exclusivity**
Every topic has one clear home. No ambiguity about where something belongs.

**Progressive Disclosure**
Top level = broad categories. Drill down = more specifics.

**Consistent Granularity**
Siblings should be at similar levels of specificity.

**Agent-Oriented**
Structure around what agents need to accomplish, not how the domain is traditionally organized.

### Review and Lock
- Workshop the structure with the team
- Debate placement decisions
- Get consensus before proceeding
- **Do not start content work until structure is finalized**

**Deliverable:** Approved KB structure document.

---

## Phase 3: KB Creation

Create the knowledgebase artifact:

```
create({
  channel: "your-channel",
  slug: "knowledgebase",
  type: "knowledgebase",
  title: "Your KB Title",
  tldr: "What this KB covers and who it's for",
  content: "# Overview\n\nRoot document introducing the KB..."
})
```

The channel name becomes the KB identifier. All KB tools use this name.

### Stub the Structure
Create placeholder documents for the entire tree:
- Title and tldr for each
- Correct `parentSlug` relationships
- Empty or minimal content initially

This creates the scaffolding and makes assignments clear.

---

## Phase 4: Content Creation

### Article Standards

**Must Have:**
- Dense, practical content—no introductory fluff
- Tables for structured/reference data
- Code examples that are complete and tested
- Gotchas section when non-obvious behaviors exist
- `[[slug]]` cross-references to related articles
- Effective tldr (1 sentence, captures essence)

**Must NOT Have:**
- "In this article we will..." style intros
- Repetition of information covered elsewhere
- Placeholder or toy examples
- Prose where a table or code block would be clearer

### Writing for Agents

Agents are smart but lack domain-specific knowledge. Write for someone who:
- Understands general programming/technical concepts
- Doesn't know this domain's specific conventions
- Needs exact values, not vague descriptions
- Will use this information immediately in their work

**Good:** "VIC-II sprite X position: $D000-$D00F (sprites 0-7), plus MSB in $D010"

**Bad:** "The sprite positions are stored in memory-mapped registers that you can access to control where sprites appear on screen."

### Coordination

**Researchers:**
- Survey sources, extract key information
- Create research artifacts with raw findings
- Identify gaps and unclear areas

**Writers:**
- Synthesize research into polished articles
- Follow article standards strictly
- Flag content that needs verification

**Lead/KB Manager:**
- Maintain structure integrity
- Review and approve additions
- Resolve placement questions

### Claiming Work

Use compare-and-swap to claim topics atomically:

```
artifact_update({
  slug: "write-vic-ii-sprites",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["your-callsign"] }
  ]
})
```

Check task status before starting. Don't duplicate effort.

---

## Phase 5: Quality & Iteration

### Quality Checklist

Before submitting any article:
- [ ] tldr is one clear, accurate sentence
- [ ] Gotchas section if applicable (upfront, not buried)
- [ ] Tables for any reference/structured data
- [ ] Code examples tested and verified
- [ ] Cross-references use `[[slug]]` format
- [ ] No fluff, no repetition, no hand-holding
- [ ] Edge cases covered
- [ ] Follows the structure (correct parentSlug)

### Test Discoverability

Use KB tools to verify content is findable:

```
kb_query({ kb: "your-kb", query: "sprite collision" })
kb_glob({ kb: "your-kb", pattern: "/hardware/**" })
```

If you can't find what you need, refine structure or add cross-references.

### Iterate

- Monitor what agents actually look for
- Identify patterns in failed searches
- Fill gaps as they become apparent
- Refine structure based on real usage

---

## KB Tools Reference

### Browsing
- `kb_list` — List all published knowledge bases
- `kb_glob(kb, pattern)` — Tree view of structure
  - `/**` — entire tree
  - `/hardware/**` — subtree
  - `/*` — root level only

### Reading
- `kb_read(kb, path)` — Read document by path

### Searching
- `kb_query(kb, query, mode)` — Search the KB
  - `mode: "keyword"` — Full-text search (default)
  - `mode: "semantic"` — Vector similarity
  - Supports: `"exact phrase"`, `prefix*`, `term AND term`

---

## Team Roles

**KB Manager**
Owns the KB structure and process. Surveys domain, designs hierarchy, coordinates team, ensures quality.

**Information Architect**
Partners with KB Manager on structure design. Focuses on taxonomy, navigation, findability.

**Researcher**
Gathers raw material. Surveys sources, extracts information, identifies topics and gaps.

**Technical Writer**
Synthesizes research into polished articles. Follows standards, optimizes for agent consumption.

**Lead**
Approves major structural decisions. Coordinates resources. Final sign-off on completion.

---

## The Goal

Build a KB so complete and well-structured that an agent with no prior domain knowledge becomes capable of expert-level work after reading the relevant sections.

The measure of success: **Can an agent go from zero to productive using only this KB?**
```
