/**
 * Import data from postgres and SQLite into Sanity
 */

import { createClient } from '@sanity/client';
import * as fs from 'fs';

const SANITY_PROJECT_ID = 'z6gp2g0b';
const SANITY_DATASET = 'production';
const SANITY_TOKEN = fs.readFileSync('./developer-token.txt', 'utf-8').trim();

const client = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  token: SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
});

// Agents from postgres staging
const agentsJson = fs.readFileSync('/tmp/staging_agents.json', 'utf-8');
const agents = JSON.parse(agentsJson) as Array<{
  slug: string;
  title: string | null;
  tldr: string;
  content: string;
  props: { engine?: string; model?: string; nameTheme?: string; agentName?: string; mcp?: Array<{ slug: string }> } | null;
}>;

// Playbooks from SQLite (hardcoded from the query)
const playbooks = [
  {
    slug: 'git-workflow',
    name: 'Git Workflow',
    description: 'Guidelines for working with git in feature branches, protecting main, and coordinating merges in team sessions.',
    content: `# Git Workflow

## Feature Branch Model

All work happens in feature branches, not directly on main. This keeps main stable and makes collaboration cleaner.

### Basic Flow

1. Create a feature branch from main: \`git checkout -b feature/my-feature\`
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

\`\`\`
main
  └── feature/auth-system        ← main feature branch
        ├── auth-system/fox      ← agent sub-branch
        ├── auth-system/bear     ← agent sub-branch
        └── auth-system/owl      ← agent sub-branch
\`\`\`

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
| Create feature branch | \`git checkout -b feature/name\` |
| Create sub-branch | \`git checkout -b feature/name/callsign\` |
| Check current branch | \`git branch --show-current\` |
| Push branch | \`git push -u origin branch-name\` |
| Switch branches | \`git checkout branch-name\` |`,
  },
  {
    slug: 'rapid-prototyping',
    name: 'Rapid Prototyping',
    description: 'Guidelines for fast-moving early-stage work where velocity matters more than ceremony. When to work directly on main and skip the usual overhead.',
    content: `# Rapid Prototyping

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

Once you have answers, slow down and build it right.`,
  },
  {
    slug: 'testing',
    name: 'Testing',
    description: 'Testing strategy for agentic workflows. Emphasizes early harnesses, user-facing interface testing, and catching the gap between "code works" and "user can use it."',
    content: `# Testing

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
\`\`\`
✓ Function works
✓ API endpoint works
✗ CLI command doesn't call the endpoint
✗ User can't access the feature
\`\`\`

### The Solution
Write integration tests that use the same interfaces users will:

- **CLI projects** — Tests should invoke the actual CLI binary
- **Web apps** — Tests should drive the browser or call REST endpoints
- **Libraries** — Tests should import and use the public API

If you test \`myFunction()\` directly but users access it through \`mycli run\`, you've tested the wrong thing.

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

Don't defer testing infrastructure. The time you "save" now costs 10x later.`,
  },
  {
    slug: 'channel-playbook-example',
    name: 'Channel Playbook Example',
    description: 'Template for project-specific channel playbooks. Copy to your channel and fill in the details.',
    content: `# Project Playbook Template

Copy this to your channel as \`project-playbook\` and fill in the sections relevant to your work.

---

## Project Overview

_One paragraph describing what this project is about and what we're building._

## Repository

- **Repo**: \`org/repo-name\`
- **Clone URL**: \`https://github.com/org/repo-name\`
- **Feature branch**: \`feature/your-feature\`
- **Base branch**: \`main\`

## Branch Strategy

\`\`\`
main
  └── feature/your-feature         ← main feature branch
        ├── your-feature/fox       ← agent sub-branch
        ├── your-feature/bear      ← agent sub-branch
        └── your-feature/owl       ← agent sub-branch
\`\`\`

- Work in your sub-branch (\`your-feature/{callsign}\`)
- Push frequently
- Coordinate merges to feature branch via steward or lead
- **Do not push to main** without explicit approval

## Key Files

_List the main files agents will be working with. Group by area if helpful._

**Backend:**
- \`src/...\` - Description

**Frontend:**
- \`src/...\` - Description

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

- Unit tests: \`npm test\`
- Integration: \`npm run test:integration\`
- Manual testing notes`,
  },
];

async function importAgents() {
  console.log(`Importing ${agents.length} agents...`);

  // Deduplicate by slug (keep first occurrence)
  const seen = new Set<string>();
  const uniqueAgents = agents.filter(a => {
    if (seen.has(a.slug)) return false;
    seen.add(a.slug);
    return true;
  });

  console.log(`${uniqueAgents.length} unique agents after deduplication`);

  for (const agent of uniqueAgents) {
    const doc = {
      _id: `agentTemplate-${agent.slug}`,
      _type: 'agentTemplate',
      name: agent.title || agent.slug,
      slug: { _type: 'slug', current: agent.slug },
      description: agent.tldr,
      engine: agent.props?.engine || 'claude-code',
      model: agent.props?.model,
      nameTheme: agent.props?.nameTheme,
      agentName: agent.props?.agentName,
      systemPrompt: agent.content,
      // Note: MCP references would need to be resolved to Sanity references
      // For now, we skip them - can be added manually in Studio
    };

    try {
      await client.createOrReplace(doc);
      console.log(`  ✓ ${agent.slug}`);
    } catch (err) {
      console.error(`  ✗ ${agent.slug}:`, err);
    }
  }
}

async function importPlaybooks() {
  console.log(`\nImporting ${playbooks.length} playbooks...`);

  for (const playbook of playbooks) {
    const doc = {
      _id: `playbook-${playbook.slug}`,
      _type: 'playbook',
      name: playbook.name,
      slug: { _type: 'slug', current: playbook.slug },
      description: playbook.description,
      category: 'workflow',
      content: playbook.content,
    };

    try {
      await client.createOrReplace(doc);
      console.log(`  ✓ ${playbook.slug}`);
    } catch (err) {
      console.error(`  ✗ ${playbook.slug}:`, err);
    }
  }
}

// Instructions from the backend defaults/instructions directory
const instructions = [
  {
    slug: 'binary-assets',
    name: 'Binary Assets',
    summary: 'How to upload and share binary files (images, PDFs, etc.)',
    content: `# Binary Assets

You can upload binary files (images, PDFs, diagrams, etc.) to share with the team without putting large data in the conversation context.

## How It Works

Binary assets are stored as files and served via HTTP at \`/boards/{channel}/{slug}\`.

## Uploading Assets

Use the \`upload_asset\` tool to upload a file from your local filesystem:

\`\`\`
upload_asset({
  channel: "design",
  path: "/tmp/mockup.png",
  slug: "homepage-mockup.png",
  tldr: "Homepage design mockup v2",
  sender: "your-callsign"
})
\`\`\`

### Parameters

- **channel**: Target channel name
- **path**: Local file path (absolute or relative to cwd)
- **slug**: Artifact identifier with file extension (e.g., \`logo.png\`, \`report.pdf\`)
- **tldr**: Brief description of the asset
- **title**: Optional display name
- **parentSlug**: Optional parent for tree structure
- **sender**: Your callsign

### Supported File Types

Images: \`.png\`, \`.jpg\`, \`.jpeg\`, \`.gif\`, \`.webp\`, \`.svg\`, \`.ico\`
Audio: \`.mp3\`, \`.wav\`, \`.ogg\`
Video: \`.mp4\`, \`.webm\`
Documents: \`.pdf\`
Fonts: \`.woff\`, \`.woff2\`, \`.ttf\`
Other: \`.zip\`, \`.wasm\`

## Accessing Assets

Once uploaded, assets are available at:
- **URL**: \`/boards/{channel}/{slug}\`
- **In chat**: Reference with \`[[slug]]\` to create a clickable link
- **In SPAs**: Fetch with \`await fetch('/boards/channel/asset.png')\`

## Example: Sharing a Generated Chart

\`\`\`
// 1. Generate chart to a file (using your preferred tool)
// ... code that creates /tmp/chart.png ...

// 2. Upload to the board
upload_asset({
  channel: "analytics",
  path: "/tmp/chart.png",
  slug: "q4-revenue.png",
  tldr: "Q4 revenue breakdown by region",
  sender: "analyst"
})

// 3. Reference in message
send_message({
  channel: "analytics",
  content: "Here's the Q4 revenue breakdown: [[q4-revenue.png]]",
  sender: "analyst"
})
\`\`\`

## Example: Screenshot for Design Review

\`\`\`
upload_asset({
  channel: "design-review",
  path: "./screenshots/login-page.png",
  slug: "login-v3.png",
  tldr: "Updated login page with social auth buttons",
  title: "Login Page v3",
  sender: "designer"
})
\`\`\`

## Storage Location

Assets are stored in a dedicated assets directory outside the database to keep it lean. They're served directly from the filesystem when requested.`,
  },
  {
    slug: 'interactive-artifacts',
    name: 'Interactive Artifacts',
    summary: 'How to create interactive apps (.app.js) that users can run',
    content: `# Interactive Artifacts (.app.js)

You can create interactive applications as artifacts. When users open these in the artifact pane (next to the chat), they see a "Run" button and can interact with your app live.

## How It Works

Create a code artifact with a \`.app.js\` extension. The content should be a JavaScript ES module that exports a default object with a \`render\` function:

\`\`\`js
export default {
  // Required: called when user clicks "Run"
  render(container, ctx) {
    // container: DOM element to render into
    // ctx: runtime context (see below)
  },

  // Optional: called when user clicks "Stop" or navigates away
  cleanup() {
    // cancel timers, stop loops, etc.
  }
}
\`\`\`

## Runtime Context

The \`ctx\` object provides:

\`\`\`js
ctx = {
  width: 800,      // Container width (updates automatically on resize)
  height: 600,     // Container height (updates automatically on resize)

  // Animation helper - calls callback(dt) each frame
  // dt = delta time in milliseconds
  // Returns a stop() function
  loop(callback) { ... },

  // Persistence (survives reload, scoped to this artifact)
  store: {
    get(key),           // Returns stored value or undefined
    set(key, value)     // Store any JSON-serializable value
  }
}
\`\`\`

**Note:** \`ctx.width\` and \`ctx.height\` update automatically when the container resizes. Just read them in your loop - no need to listen for resize events.

## Example: Bouncing Ball

\`\`\`
artifact_create({
  channel: "my-channel",
  slug: "bouncing-ball.app.js",
  type: "code",
  title: "Bouncing Ball",
  tldr: "A simple bouncing ball animation",
  sender: "your-callsign",
  content: \`export default {
  render(container, ctx) {
    container.innerHTML = \\\`<canvas width="\${ctx.width}" height="\${ctx.height}"></canvas>\\\`;
    const canvas = container.querySelector('canvas');
    const c = canvas.getContext('2d');

    let x = ctx.width / 2, y = ctx.height / 2;
    let vx = 200, vy = 150;

    this.stop = ctx.loop((dt) => {
      // Update position
      x += vx * dt / 1000;
      y += vy * dt / 1000;
      if (x < 20 || x > ctx.width - 20) vx *= -1;
      if (y < 20 || y > ctx.height - 20) vy *= -1;

      // Draw
      c.fillStyle = '#111';
      c.fillRect(0, 0, ctx.width, ctx.height);
      c.fillStyle = '#0ff';
      c.beginPath();
      c.arc(x, y, 20, 0, Math.PI * 2);
      c.fill();
    });
  },

  cleanup() {
    this.stop?.();
  }
}\`
})
\`\`\`

## Key Points

1. **Raw JavaScript**: Content is raw JS code, not wrapped in markdown fences
2. **Always cleanup**: Stop your loops in \`cleanup()\` or you'll leak memory
3. **Use ctx.loop()**: Don't use setInterval/setTimeout - ctx.loop handles cleanup
4. **Use ctx dimensions**: Don't hardcode sizes - ctx.width/height auto-update on resize
5. **Canvas for graphics**: Use HTML canvas for animations and visualizations
6. **DOM for UI**: You can add buttons, sliders, etc. with standard HTML/DOM

## With UI Controls

\`\`\`js
export default {
  render(container, ctx) {
    container.innerHTML = \`
      <div style="display:flex; gap:1rem; margin-bottom:0.5rem; color:#fff;">
        <label>Speed: <input type="range" id="speed" min="1" max="10" value="5"></label>
        <button id="reset">Reset</button>
      </div>
      <canvas width="\${ctx.width}" height="\${ctx.height - 40}"></canvas>
    \`;

    const canvas = container.querySelector('canvas');
    const speedSlider = container.querySelector('#speed');
    const resetBtn = container.querySelector('#reset');

    let x = 0;
    resetBtn.onclick = () => { x = 0; };

    this.stop = ctx.loop((dt) => {
      const speed = parseFloat(speedSlider.value);
      x = (x + speed * dt / 10) % canvas.width;

      const c = canvas.getContext('2d');
      c.fillStyle = '#111';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#f80';
      c.fillRect(x, canvas.height / 2 - 10, 20, 20);
    });
  },

  cleanup() {
    this.stop?.();
  }
}
\`\`\`

## Persisting State

Use \`ctx.store\` to save state across app restarts:

\`\`\`js
render(container, ctx) {
  let highScore = ctx.store.get('highScore') || 0;

  // ... game logic ...

  if (score > highScore) {
    highScore = score;
    ctx.store.set('highScore', highScore);
  }
}
\`\`\`

## Fetching Board Artifacts

Your app can fetch other artifacts from the board using \`/boards/{channel}/{slug}\`:

\`\`\`js
// Fetch JSON data from another artifact
const response = await fetch('/boards/my-channel/config.json');
const config = await response.json();

// Fetch text content
const readme = await fetch('/boards/my-channel/readme.md');
const text = await readme.text();

// Load an SVG image
const svg = await fetch('/boards/my-channel/diagram.svg');
const svgText = await svg.text();
container.innerHTML = svgText;

// Load a binary image (uploaded via upload_asset)
const img = new Image();
img.src = '/boards/my-channel/photo.png';
container.appendChild(img);
\`\`\`

The Content-Type is set based on the artifact's file extension:
- \`.json\` → \`application/json\`
- \`.js\` → \`text/javascript\`
- \`.svg\` → \`image/svg+xml\`
- \`.md\` → \`text/markdown\`
- \`.html\` → \`text/html\`
- \`.css\` → \`text/css\`
- \`.png\`, \`.jpg\`, \`.gif\` → appropriate image types
- etc.

This lets you build apps that load data, configurations, or assets from other artifacts on the board. Binary assets uploaded via \`upload_asset\` are served the same way.

# Loading External Libraries in Interactive Artifacts

You can load any npm package in your \`.app.js\` artifacts using dynamic imports from **esm.sh** — a CDN that serves npm packages as ES modules.

## Basic Pattern

\`\`\`js
export default {
  async render(container, ctx) {
    // Load library at runtime
    const THREE = await import('https://esm.sh/three@0.160.0');

    // Use it
    const scene = new THREE.Scene();
  }
}
\`\`\`

**Key points:**
- Make \`render()\` an \`async\` function
- Use \`await import('https://esm.sh/package@version')\`
- Pin versions for stability (e.g., \`three@0.160.0\`)

## Common Libraries

### Three.js (3D graphics)
\`\`\`js
const THREE = await import('https://esm.sh/three@0.160.0');

// With add-ons (OrbitControls, etc.)
const { OrbitControls } = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
\`\`\`

### D3 (data visualization)
\`\`\`js
const d3 = await import('https://esm.sh/d3@7');

// Or specific modules
const { scaleLinear, axisBottom } = await import('https://esm.sh/d3@7');
\`\`\`

### GSAP (animation)
\`\`\`js
const { gsap } = await import('https://esm.sh/gsap@3');
\`\`\`

### Chart.js
\`\`\`js
const { Chart } = await import('https://esm.sh/chart.js@4/auto');
\`\`\`

### Lodash
\`\`\`js
const _ = await import('https://esm.sh/lodash-es@4');
\`\`\`

### Tone.js (audio)
\`\`\`js
const Tone = await import('https://esm.sh/tone@14');
\`\`\`

### Matter.js (2D physics)
\`\`\`js
const Matter = await import('https://esm.sh/matter-js@0.19');
\`\`\`

## Alternative CDNs

- **esm.sh** (recommended): \`https://esm.sh/package@version\`
- **Skypack**: \`https://cdn.skypack.dev/package@version\`
- **jsDelivr**: \`https://esm.run/package@version\`

## Tips

1. **Pin versions** — Avoid breaking changes: \`three@0.160.0\` not just \`three\`

2. **Load once** — Store references if you need them across frames:
   \`\`\`js
   // Good: load in render, store on this
   this.THREE = await import('https://esm.sh/three@0.160.0');
   \`\`\`

3. **Handle loading state** — Show feedback while loading large libs:
   \`\`\`js
   container.innerHTML = '<div style="color:#fff;">Loading Three.js...</div>';
   const THREE = await import('https://esm.sh/three@0.160.0');
   container.innerHTML = ''; // Clear and render
   \`\`\`

4. **Check esm.sh docs** — Some packages need special handling: https://esm.sh`,
  },
  {
    slug: 'system-mcp',
    name: 'MCP Server Configuration',
    summary: 'How to configure MCP servers and assign them to agents',
    content: `# MCP Server Configuration

You can configure external MCP (Model Context Protocol) servers to extend agent capabilities with additional tools. MCP servers are defined as \`system.mcp\` artifacts and assigned to agents via \`props.mcp\`.

## Creating an MCP Server Definition

Use the \`create\` artifact tool to define an MCP server:

\`\`\`
create({
  channel: "my-channel",   // or "root" for global availability
  slug: "github-mcp",
  type: "system.mcp",
  tldr: "GitHub API tools for repo management, PRs, and issues",
  sender: "your-callsign",
  content: "",
  props: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
    }
  }
})
\`\`\`

## Transport Types

### stdio (Command-line MCP servers)

Most MCP servers run as local processes communicating via stdin/stdout:

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
  "env": {
    "SOME_VAR": "value"
  },
  "cwd": "/optional/working/directory"
}
\`\`\`

**Props:**
- \`transport\`: \`"stdio"\` (required)
- \`command\`: Executable to run (required)
- \`args\`: Command-line arguments (optional)
- \`env\`: Environment variables (optional, supports \`\${VAR}\` references)
- \`cwd\`: Working directory (optional)

### http (Remote MCP servers)

For remote MCP servers accessible via HTTP:

\`\`\`json
{
  "transport": "http",
  "url": "https://mcp.example.com",
  "headers": {
    "Authorization": "Bearer \${API_KEY}"
  }
}
\`\`\`

**Props:**
- \`transport\`: \`"http"\` (required)
- \`url\`: Server URL (required)
- \`headers\`: HTTP headers (optional, supports \`\${VAR}\` references)

## Environment Variable References

Use \`\${VAR_NAME}\` syntax to reference environment variables:

\`\`\`json
{
  "env": {
    "GITHUB_TOKEN": "\${GITHUB_TOKEN}",
    "DEBUG": "true"
  }
}
\`\`\`

Variables are resolved at agent spawn time from the server's environment. If a variable is not found, a warning is logged and the original \`\${VAR}\` string is preserved.

## Channel Inheritance

MCP definitions follow the same inheritance pattern as other artifacts:

- **Root-level** (\`#root\` channel): Available to all agents across all channels
- **Channel-level**: Available only to agents in that specific channel
- **Override**: Channel-level definitions with the same slug override root-level

Example: If both \`#root\` and \`#project-x\` have a \`system.mcp\` with slug \`github\`, agents in \`#project-x\` will use the channel-level definition.

## Assigning MCPs to Agents

MCPs are not automatically available. Each agent explicitly declares which MCPs it can access via \`props.mcp\` on the \`system.agent\` artifact:

\`\`\`
update({
  channel: "my-channel",
  slug: "builder",  // system.agent slug
  changes: [{
    field: "props",
    old_value: { "engine": "claude" },
    new_value: {
      "engine": "claude",
      "mcp": [
        { "slug": "github-mcp" },
        { "slug": "filesystem" }
      ]
    }
  }],
  sender: "your-callsign"
})
\`\`\`

Or when creating a new agent:

\`\`\`
create({
  channel: "my-channel",
  slug: "my-builder",
  type: "system.agent",
  tldr: "Builder agent with GitHub and filesystem access",
  sender: "your-callsign",
  content: "System prompt here...",
  props: {
    "engine": "claude",
    "mcp": [
      { "slug": "github-mcp" },
      { "slug": "filesystem" }
    ]
  }
})
\`\`\`

## Runtime Behavior

- MCP configuration is loaded at agent spawn time
- Changes to \`system.mcp\` or agent \`props.mcp\` do not affect running agents
- Agents must be restarted to pick up configuration changes
- The built-in powpow MCP (artifact tools, messaging) is always provided and cannot be disabled

## Schema Discovery

Use \`explain_artifact_type\` to get the JSON Schema for valid props:

\`\`\`
explain_artifact_type({ type: "system.mcp" })
\`\`\`

This returns the schema for validation along with documentation and examples. When creating/updating artifacts with invalid props, structured error feedback includes the full schema.

## Common MCP Server Examples

### GitHub

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
}
\`\`\`

### Filesystem (scoped to directory)

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects/myapp"]
}
\`\`\`

### Sanity CMS

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@sanity/mcp-server@latest"],
  "env": {
    "SANITY_PROJECT_ID": "\${SANITY_PROJECT_ID}",
    "SANITY_DATASET": "production",
    "SANITY_API_TOKEN": "\${SANITY_API_TOKEN}"
  }
}
\`\`\`

### Custom Internal API (HTTP)

\`\`\`json
{
  "transport": "http",
  "url": "https://internal.company.com/mcp",
  "headers": {
    "Authorization": "Bearer \${INTERNAL_API_KEY}"
  }
}
\`\`\`

## Troubleshooting

**MCP not available to agent:**
- Check the agent's \`props.mcp\` includes the MCP slug
- Verify the \`system.mcp\` artifact exists in the agent's channel or \`#root\`
- Ensure the engine supports MCP (\`supportsMcp: true\` in capabilities)

**Environment variable not resolved:**
- Check the variable is set in the server's environment
- Variable names are case-sensitive

**Connection errors:**
- For stdio: verify the command path and arguments are correct
- For http: verify the URL is accessible from the server`,
  },
];

async function importInstructions() {
  console.log(`\nImporting ${instructions.length} instructions...`);

  for (const instruction of instructions) {
    const doc = {
      _id: `instruction-${instruction.slug}`,
      _type: 'instruction',
      name: instruction.name,
      slug: { _type: 'slug', current: instruction.slug },
      summary: instruction.summary,
      content: instruction.content,
    };

    try {
      await client.createOrReplace(doc);
      console.log(`  ✓ ${instruction.slug}`);
    } catch (err) {
      console.error(`  ✗ ${instruction.slug}:`, err);
    }
  }
}

async function main() {
  console.log('Starting Sanity import...\n');
  await importAgents();
  await importPlaybooks();
  await importInstructions();
  console.log('\nDone!');
}

main().catch(console.error);
