# Focus Types & Channel Configuration

Focus types define channel presets—default teams, taglines, missions, and initial prompts that set the tone for different kinds of work.

---

## How Focus Types Work

When a channel is created with a focus type:
1. The **default team** of agents is summoned automatically
2. The **tagline** and **mission** are set as channel metadata
3. The **initial prompt** is given to the lead agent to start the conversation

Focus types live in `#root` as `system.focus` artifacts.

---

## Open

**Slug:** `open`
**Title:** Open

### Props
```json
{
  "agents": ["lead"],
  "defaultTagline": "Open workspace",
  "defaultMission": "A flexible space for freeform collaboration and exploration.",
  "initialPrompt": "Ok, let's figure out what the user wants to explore today!"
}
```

### Content
```
An open-ended focus area for work that doesn't fit a specific template.

## Default Team
- **Lead** — Coordinates and facilitates whatever needs doing

## When to Use
- Exploratory work without a clear structure
- Ad-hoc tasks and conversations
- Projects that don't fit other focus templates
- General collaboration and planning
```

---

## Marketing

**Slug:** `marketing`
**Title:** Marketing

### Props
```json
{
  "agents": ["lead", "creativewriter"],
  "defaultTagline": "Marketing workspace",
  "defaultMission": "Develop compelling marketing that connects with our audience and drives results.",
  "initialPrompt": "Let's understand the marketing challenge. What are we promoting, who's the audience, and what action do we want them to take?"
}
```

### Content
```
Focus area for marketing work—campaigns, messaging, positioning, and promotional content.

## Default Team
- **Lead** — Coordinates the marketing effort, captures strategy on the board
- **Creative Writer** — Crafts compelling copy that surprises and delights
- **Content Writer** — Produces blog posts, emails, and marketing collateral

## When to Use
- Planning marketing campaigns
- Developing brand messaging and positioning
- Creating promotional content (ads, emails, landing pages)
- Launch planning and go-to-market strategy
```

---

## Strategy

**Slug:** `strategy`
**Title:** Strategy

### Props
```json
{
  "agents": ["lead", "researcher", "contrarian"],
  "defaultTagline": "Strategy workspace",
  "defaultMission": "Think clearly about where we're going and how to get there.",
  "initialPrompt": "What strategic question are we tackling? Let's understand the context, constraints, and what success looks like."
}
```

### Content
```
Focus area for strategic thinking—business planning, competitive analysis, and major decisions.

## Default Team
- **Lead** — Facilitates strategic discussions, captures decisions on the board
- **Researcher** — Gathers market data, competitive intelligence, and relevant information
- **Contrarian** — Challenges assumptions and raises uncomfortable questions

## When to Use
- Business planning and goal setting
- Competitive analysis and market positioning
- Major decisions requiring structured thinking
- Evaluating opportunities and risks
```

---

## Content Operations

**Slug:** `contentops`
**Title:** Content Operations

### Props
```json
{
  "agents": ["lead", "contentmodeler", "technicalwriter", "contentwriter"],
  "defaultTagline": "Content workspace",
  "defaultMission": "Create, organize, and deliver content that serves our audience effectively.",
  "initialPrompt": "What content challenge are we solving? Let's understand the audience, the channels, and the content we need to create or organize."
}
```

### Content
```
Focus area for content operations—editorial strategy, content planning, and publication workflows.

## Default Team
- **Lead** — Coordinates content efforts, maintains editorial calendar
- **Content Modeler** — Designs content structures that scale and reuse well
- **Technical Writer** — Produces clear, well-structured documentation and guides
- **Content Writer** — Creates engaging prose for various channels

## When to Use
- Building content strategy and editorial calendars
- Designing content models for CMS platforms
- Planning documentation and knowledge bases
- Managing content production workflows
```

---

## Research

**Slug:** `research`
**Title:** Research

### Props
```json
{
  "agents": ["lead", "researcher", "infoarchitect"],
  "defaultTagline": "Research workspace",
  "defaultMission": "Gather the information we need to make good decisions.",
  "initialPrompt": "What do we need to learn? Let's define the research questions, identify sources, and plan how to synthesize what we find."
}
```

### Content
```
Focus area for research and analysis—gathering information, synthesizing insights, and building understanding.

## Default Team
- **Lead** — Frames research questions, coordinates findings
- **Researcher** — Gathers and synthesizes information from multiple sources
- **Info Architect** — Organizes findings into navigable, useful structures

## When to Use
- Market research and competitive analysis
- User research and customer insights
- Technology evaluation and vendor comparison
- Building knowledge bases and reference materials
```

---

## Proposal

**Slug:** `proposal`
**Title:** Proposal

### Props
```json
{
  "agents": ["lead", "creativewriter", "researcher"],
  "defaultTagline": "Proposal workspace",
  "defaultMission": "Build a compelling case that wins hearts and minds.",
  "initialPrompt": "What are we proposing and to whom? Let's understand the audience, what they care about, and what we need them to believe or do."
}
```

### Content
```
Focus area for creating persuasive business documents—proposals, pitches, and presentations.

## Default Team
- **Lead** — Shapes the narrative, coordinates the pitch
- **Creative Writer** — Crafts compelling stories and hooks
- **Researcher** — Gathers supporting evidence and competitive context

## When to Use
- Sales proposals and RFP responses
- Investment pitches and business cases
- Partnership proposals
- Internal presentations requiring buy-in
```

---

## Editorial

**Slug:** `editorial`
**Title:** Editorial

### Props
```json
{
  "agents": ["lead", "creativewriter", "illustrator"],
  "defaultTagline": "Editorial workspace",
  "defaultMission": "Create content worth reading and sharing.",
  "initialPrompt": "What story are we telling? Let's understand the angle, the audience, and what makes this worth their attention."
}
```

### Content
```
Focus area for editorial and publication work—articles, blog posts, thought leadership, and visual storytelling.

## Default Team
- **Lead** — Editorial direction, coordinates publication
- **Creative Writer** — Crafts engaging narratives that hook readers
- **Illustrator** — Creates visual content that amplifies the message

## When to Use
- Blog posts and articles
- Thought leadership and opinion pieces
- Newsletters and editorial content
- Visual storytelling projects
```

---

## Brainstorm

**Slug:** `brainstorm`
**Title:** Brainstorm

### Props
```json
{
  "agents": ["lead", "creativewriter", "contrarian"],
  "defaultTagline": "Brainstorm workspace",
  "defaultMission": "Generate ideas worth pursuing. Quantity first, quality second.",
  "initialPrompt": "What are we brainstorming? Let's understand the challenge, any constraints, and what a great outcome looks like. Then let's generate options."
}
```

### Content
```
Focus area for creative ideation—generating ideas, exploring possibilities, and finding unexpected solutions.

## Default Team
- **Lead** — Facilitates ideation, captures promising directions
- **Creative Writer** — Brings unexpected angles and fresh perspectives
- **Contrarian** — Challenges groupthink, pushes for better ideas

## When to Use
- Naming and branding sessions
- Product ideation and feature brainstorms
- Problem-solving when stuck
- Creative exploration before committing to direction
```

---

## Focus Type Props Schema

Focus types use these props:

| Property | Type | Description |
|----------|------|-------------|
| `agents` | string[] | Array of agent slugs to summon by default |
| `defaultTagline` | string | Short label for the channel |
| `defaultMission` | string | Longer description of the channel's purpose |
| `initialPrompt` | string | First message given to the lead agent |

---

## Creating New Focus Types

To add a new focus type:

```javascript
create({
  channel: "root",
  slug: "your-focus",
  type: "system.focus",
  title: "Your Focus",
  tldr: "Brief description of what this focus is for.",
  parentSlug: "focus",
  content: "Detailed description...",
  props: {
    agents: ["lead", "other-agents"],
    defaultTagline: "Your workspace",
    defaultMission: "What this channel is for.",
    initialPrompt: "Opening prompt for the lead."
  }
})
```
