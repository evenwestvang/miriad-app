# Cast Design Manual

A comprehensive guide for design engineers implementing the Cast interface using shadcn/ui. This document captures the Swiss/zen minimalist aesthetic and provides exact specifications for faithful implementation.

---

## Design Philosophy

Cast follows a **Swiss minimalist** approach with zen influences:

- **Clarity over decoration** — every element earns its place
- **Generous whitespace** — let content breathe
- **Flat, sharp geometry** — no rounded corners, no shadows, no gradients
- **Restrained color** — mostly grayscale with a single accent
- **Typography-driven hierarchy** — weight and size, not color, create structure

The goal is an interface that feels calm, professional, and focused. Users should feel they're in control, not overwhelmed.

---

## Color Palette

### Core Colors

```css
/* Primary text */
--text-primary: #1a1a1a;

/* Secondary text */
--text-secondary: #666666;

/* Muted text (labels, timestamps, placeholders) */
--text-muted: #8c8c8c;

/* Extra muted (disabled states, subtle hints) */
--text-subtle: #a0a0a0;

/* Borders */
--border-default: #e5e5e5;
--border-subtle: #f0f0f0;

/* Backgrounds */
--bg-primary: #ffffff;
--bg-hover: #f5f5f5;
--bg-active: #f0f0f0;

/* Accent — Cast Orange */
--accent: #de946a;
```

### shadcn/ui Overrides

In your `globals.css` or tailwind config:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 0 0% 10%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 55%;
  --border: 0 0% 90%;
  --ring: 0 0% 10%;
  --radius: 0px; /* CRITICAL: no border radius */
}
```

**Important:** The default shadcn/ui has `--radius: 0.5rem`. Override this to `0px` globally. Cast uses **zero border radius everywhere**.

---

## Typography

### Font Stack

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

Load Inter from Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

### Type Scale

| Element | Size | Weight | Color | Letter Spacing |
|---------|------|--------|-------|----------------|
| Logo (CAST) | 14px | 600 | #de946a | 0.05em |
| Section labels | 11px | 500 | #8c8c8c | 0.05em (uppercase) |
| Tab labels | 13px | 500 | #8c8c8c / #1a1a1a | — |
| Body text | 14px | 400 | #2c2c2c | — |
| Timestamps | 12px | 400 | #8c8c8c | — |
| Message author | 14px | 600 | #1a1a1a | — |
| Channel names | 14px | 400/500 | #666 / #1a1a1a | — |

### Line Height

- Body text: `1.5`
- UI elements (buttons, tabs): `1`

---

## Spacing System

Use a **4px base unit**. Common values:

| Token | Value | Usage |
|-------|-------|-------|
| `space-1` | 4px | Tight gaps (icon to text) |
| `space-2` | 8px | Default small gap |
| `space-3` | 12px | Input padding, message gaps |
| `space-4` | 16px | Section padding |
| `space-6` | 24px | Large content padding |

### Panel Padding

- Sidebar: `16px` horizontal
- Chat messages: `24px` all sides
- Input area: `16px 24px`
- Tree items: `6px 16px`

---

## Layout Structure

### Overall Grid

```
┌──────────────────────────────────────────────────────────────────┐
│ Header (48px fixed)                                              │
├────────────┬─────────────────────────────────┬───────────────────┤
│ Sidebar    │ Center Panel                    │ Right Panel       │
│ 220px      │ flex: 1 (fills remaining)       │ 320px             │
│ fixed      │                                 │ fixed             │
└────────────┴─────────────────────────────────┴───────────────────┘
```

### Implementation with Tailwind

```tsx
<div className="flex flex-col h-screen bg-white">
  {/* Header */}
  <header className="h-12 border-b border-[#e5e5e5] flex items-center justify-between px-5 shrink-0">
    {/* ... */}
  </header>
  
  {/* Main content */}
  <div className="flex flex-1 overflow-hidden">
    {/* Sidebar */}
    <aside className="w-[220px] border-r border-[#e5e5e5] flex flex-col shrink-0 overflow-hidden">
      {/* ... */}
    </aside>
    
    {/* Center panel */}
    <main className="flex-1 flex flex-col border-r border-[#e5e5e5] overflow-hidden min-w-0">
      {/* ... */}
    </main>
    
    {/* Right panel */}
    <aside className="w-[320px] flex flex-col shrink-0 overflow-hidden">
      {/* ... */}
    </aside>
  </div>
</div>
```

---

## Component Specifications

### Header

```
Height: 48px
Padding: 0 20px
Border: 1px solid #e5e5e5 (bottom only)

Logo:
  - Text: "CAST"
  - Color: #de946a (Cast orange)
  - Font: 14px, weight 600, letter-spacing 0.05em

Breadcrumb:
  - Channel name: weight 500
  - Separator: "—" in #ccc
  - Tagline: #8c8c8c

User display:
  - Icon: Lucide "User" at 16px, color #8c8c8c
  - Name: 13px, color #666
  - Gap: 8px between icon and name
```

### Sidebar

```
Width: 220px fixed

New Channel (above "CHANNELS" label):
  - Padding: 8px 16px
  - Icon: Plus, 12px, stroke-width 2.5
  - Text: "New Channel", 14px
  - Color: #8c8c8c → #1a1a1a on hover
  - Background: transparent → #f5f5f5 on hover
  - Margin-bottom: 8px

Section Label:
  - Text: "CHANNELS" (uppercase)
  - Font: 11px, weight 500
  - Color: #8c8c8c
  - Letter-spacing: 0.05em
  - Padding: 0 16px 8px

Channel Item:
  - Padding: 6px 16px
  - Font: 14px
  - Color: #666 → #1a1a1a when active
  - Background: transparent → #f5f5f5 hover, #f0f0f0 active
  - Active state also gets font-weight 500
  - Hash symbol: #a0a0a0

Channel Item (with chevron):
  - Chevron: 12px, color #ccc, margin-left auto
```

### Panel Tabs (Chat/Board headers)

```
Container:
  - Padding: 0 16px
  - Border-bottom: 1px solid #e5e5e5
  - No gap between tabs

Tab:
  - Padding: 8px 16px
  - Font: 13px, weight 500
  - Color: #8c8c8c (inactive), #1a1a1a (active)
  - Border-bottom: 2px solid transparent (inactive), #1a1a1a (active)
  - Margin-bottom: -1px (overlaps container border)
  - Transition: all 0.15s ease
```

**Critical:** The tab's bottom border must overlap the container's bottom border. Use `margin-bottom: -1px` on the tab.

### Messages

```
Container padding: 24px
Message gap: 32px (margin-bottom on each message)

Avatar:
  - Size: 40px × 40px
  - Border-radius: 50%
  - Margin-top: -8px (aligns with first line of text)
  - Margin-right: -10px (tightens gap slightly)

Content gap from avatar: 16px

Header:
  - Display: flex, align-items: baseline
  - Gap: 12px between elements
  - Margin-bottom: 6px

  Name:
    - Font: 15px, weight 600
    - Color: #1a1a1a
    - Letter-spacing: -0.01em

  Timestamp:
    - Font: 12px, weight 400
    - Color: #8c8c8c
    - Letter-spacing: 0.02em

  Role/Status:
    - Font: 12px
    - Color: #a0a0a0
    - Format: "role – current activity" (en-dash separator)

Body:
  - Font: 15px
  - Line-height: 1.6
  - Color: #2c2c2c
  - Letter-spacing: -0.008em
  - Paragraph margin: 0 0 12px (last paragraph margin: 0)
```

---

## Chat Log Content Types

The chat supports rich content beyond plain text. Each content type has specific styling.

### Inline Cards (Structured Data)

For displaying structured information like task status, metadata, etc.

```
Container:
  - Border: 1px solid #e5e5e5
  - Background: #fafafa
  - Padding: 16px
  - Margin-top: 12px
  - Border-radius: 0 (sharp!)

Card Grid:
  - Display: grid
  - Grid-template-columns: 1fr 1fr
  - Gap: 12px

Card Field:
  Label:
    - Font: 11px, weight 500
    - Text-transform: uppercase
    - Letter-spacing: 0.08em
    - Color: #8c8c8c
    - Margin-bottom: 4px
  
  Value:
    - Font: 14px
    - Color: #1a1a1a
```

```tsx
// Example implementation
<div className="border border-[#e5e5e5] bg-[#fafafa] p-4 mt-3">
  <div className="grid grid-cols-2 gap-3">
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#8c8c8c] mb-1">
        Status
      </div>
      <div className="text-sm text-[#1a1a1a]">In Progress</div>
    </div>
    {/* ... more fields */}
  </div>
</div>
```

### File Attachments

```
Container:
  - Display: flex
  - Align-items: center
  - Gap: 10px
  - Padding: 10px 12px
  - Border: 1px solid #e5e5e5
  - Background: #fafafa
  - Cursor: pointer
  - Transition: border-color 0.15s ease
  - Hover: border-color #ccc

Icon:
  - Size: 20px
  - Color: #666
  - Use FileCode for code files, File for docs, Image for images

File Info:
  Name:
    - Font: 14px, weight 500
    - Color: #1a1a1a
    - White-space: nowrap
    - Overflow: hidden
    - Text-overflow: ellipsis
  
  Meta:
    - Font: 12px
    - Color: #8c8c8c
    - Format: "TypeScript · 4.2 KB" (language + size)

Multiple attachments:
  - Stack vertically with 8px gap
  - Margin-top: 12px from message body
```

```tsx
// Example implementation
<div className="flex flex-col gap-2 mt-3">
  <div className="flex items-center gap-2.5 px-3 py-2.5 border border-[#e5e5e5] bg-[#fafafa] cursor-pointer hover:border-[#ccc] transition-colors">
    <FileCode className="w-5 h-5 text-[#666] shrink-0" />
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-[#1a1a1a] truncate">auth-middleware.ts</div>
      <div className="text-xs text-[#8c8c8c]">TypeScript · 4.2 KB</div>
    </div>
  </div>
</div>
```

### Image Attachments

```
Container:
  - Border: 1px solid #e5e5e5
  - Margin-top: 12px
  - Overflow: hidden

Image:
  - Display: block
  - Width: 100%
  - Height: auto
  - No border-radius
```

```tsx
<div className="border border-[#e5e5e5] mt-3">
  <img src={src} alt={alt} className="block w-full h-auto" />
</div>
```

### Code Blocks

```
Container:
  - Border: 1px solid #e5e5e5
  - Background: #fafafa
  - Margin-top: 12px
  - Overflow: hidden

Header:
  - Display: flex
  - Justify-content: space-between
  - Align-items: center
  - Padding: 8px 12px
  - Border-bottom: 1px solid #e5e5e5
  - Background: #f5f5f5

  Language label:
    - Font: 11px, weight 500
    - Text-transform: uppercase
    - Letter-spacing: 0.05em
    - Color: #666

  Copy button:
    - Icon: Copy, 16px
    - Color: #8c8c8c → #1a1a1a on hover
    - No background, no border
    - Padding: 4px

Content:
  - Padding: 16px
  - Overflow-x: auto
  - Font-family: 'SF Mono', Monaco, Inconsolata, 'Fira Code', monospace
  - Font-size: 13px
  - Line-height: 1.5
  - Color: #1a1a1a

Syntax highlighting (minimal palette):
  - Comments: #6a737d
  - Keywords: #d73a49
  - Strings: #032f62
  - Functions: #6f42c1
```

```tsx
<div className="border border-[#e5e5e5] bg-[#fafafa] mt-3 overflow-hidden">
  <div className="flex justify-between items-center px-3 py-2 border-b border-[#e5e5e5] bg-[#f5f5f5]">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[#666]">
      TypeScript
    </span>
    <button className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors">
      <Copy className="w-4 h-4" />
    </button>
  </div>
  <pre className="p-4 overflow-x-auto font-mono text-[13px] leading-relaxed text-[#1a1a1a]">
    <code>{code}</code>
  </pre>
</div>
```

### Reactions

```
Container:
  - Display: flex
  - Gap: 8px
  - Margin-top: 12px

Reaction:
  - Display: flex
  - Align-items: center
  - Gap: 6px
  - Padding: 4px 8px
  - Border: 1px solid transparent
  - Background: transparent
  - Font-size: 13px
  - Cursor: pointer
  - Transition: background 0.15s ease, border-color 0.15s ease
  - Hover: background #f5f5f5, border-color #e5e5e5

  Icon:
    - Size: 16px
    - Use Lucide icons (ThumbsUp, Clock, Heart, etc.)
  
  Count:
    - Color: #666
    - Font-weight: 500
```

```tsx
<div className="flex gap-2 mt-3">
  <button className="flex items-center gap-1.5 px-2 py-1 border border-transparent hover:bg-[#f5f5f5] hover:border-[#e5e5e5] transition-all text-[13px]">
    <ThumbsUp className="w-4 h-4" />
    <span className="text-[#666] font-medium">2</span>
  </button>
</div>
```

---

## Complete Message Component

Here's a full React component implementing all message features:

```tsx
interface MessageProps {
  avatar: string;
  name: string;
  timestamp: string;
  role: string;
  status: string;
  content: React.ReactNode;
}

function Message({ avatar, name, timestamp, role, status, content }: MessageProps) {
  return (
    <div className="flex gap-4 mb-8">
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 -mt-2 -mr-2.5">
        <img src={avatar} alt={name} className="w-full h-full object-cover" />
      </div>
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-baseline gap-3 mb-1.5">
          <span className="font-semibold text-[15px] text-[#1a1a1a] tracking-tight">
            {name}
          </span>
          <span className="text-xs text-[#8c8c8c] tracking-wide">
            {timestamp}
          </span>
          <span className="text-xs text-[#a0a0a0]">
            {role} – {status}
          </span>
        </div>
        
        {/* Body */}
        <div className="text-[15px] leading-relaxed text-[#2c2c2c] tracking-tight">
          {content}
        </div>
      </div>
    </div>
  );
}
```

---

## Message Typography Details

### Text Rendering

The chat uses slightly larger text (15px vs 14px in sidebar) for readability in longer-form content. Key details:

- **Letter-spacing: -0.008em** — Tightens Inter slightly for body text
- **Line-height: 1.6** — More generous than UI elements for readability
- **Color: #2c2c2c** — Slightly softer than pure #1a1a1a for long-form reading

### Paragraph Flow

```css
.message-body p {
  margin: 0 0 12px 0;
}

.message-body p:last-child {
  margin-bottom: 0;
}
```

No first-line indents. No drop caps. Clean, blog-style paragraphs.

### Whitespace Strategy

The chat log uses generous vertical rhythm:

- **32px** between messages (enough to clearly separate conversations)
- **12px** between paragraphs within a message
- **12px** margin-top for attachments/code/cards below text
- **6px** between header and body

This creates clear visual grouping while maintaining scanability.

### Agent Roster (above input)

The roster shows all agents in the channel with status indicators.

```
Container:
  - Display: flex, justify-content: space-between
  - Margin-bottom: 8px
  - Font-size: 12px

Roster items (left side):
  - Display: flex
  - Gap: 12px between agents

Each agent:
  - Display: flex, align-items: center
  - Gap: 4px
  - Cursor: pointer

Status dot:
  - Width/height: 6px
  - Border-radius: 50%

States:
  WORKING (actively processing):
    - Dot: #de946a with pulse animation
    - Name: #de946a
    
  ATTENTIVE (listening, ready):
    - Dot: #de946a solid
    - Name: #de946a
    
  IDLE (standby):
    - Dot: #c0c0c0
    - Name: #a0a0a0

Pulse animation:
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}
animation: pulse 2s ease-in-out infinite;

Add Agent button (right side):
  - Icon: Plus, 12px
  - Text: "Add agent"
  - Color: #a0a0a0 → #1a1a1a on hover
  - No background, no border
```

### Input Box

```
Container:
  - Border: 1px solid #e5e5e5
  - Border-radius: 0 (sharp corners!)
  - Focus-within: border-color #1a1a1a

Textarea:
  - Padding: 12px
  - No border, no outline
  - Font: inherit, 14px
  - Placeholder color: #a0a0a0

Actions bar:
  - Padding: 8px 12px
  - Border-top: 1px solid #f0f0f0
  - Display: flex, justify-content: space-between

Action buttons:
  - Padding: 4px
  - Color: #8c8c8c → #1a1a1a on hover
  - No background
```

### Tree View (Board panel)

```
Item:
  - Padding: 6px 16px
  - Font: 13px
  - Color: #666
  - Background: transparent → #f5f5f5 on hover

Depth indentation:
  - Level 0: padding-left 16px
  - Level 1: padding-left 28px
  - Level 2: padding-left 44px
  - Level 3: padding-left 60px
  (Each level adds 16px, except first child adds 12px)

Icon:
  - Size: 16px
  - Color: #a0a0a0

Chevron:
  - Size: 12px
  - Color: #ccc
```

---

## shadcn/ui Component Mapping

### Button variants needed

```tsx
// Ghost button (most actions)
<Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">

// No default buttons with backgrounds in the main UI
// Primary actions use icons or text links
```

### Input

Override the default Input component:

```tsx
<Input 
  className="rounded-none border-[#e5e5e5] focus:border-[#1a1a1a] focus:ring-0"
/>
```

### Tabs

Use shadcn Tabs but override styling:

```tsx
<Tabs>
  <TabsList className="bg-transparent border-b border-[#e5e5e5] rounded-none h-auto p-0 px-4">
    <TabsTrigger 
      className="rounded-none border-b-2 border-transparent data-[state=active]:border-[#1a1a1a] 
                 data-[state=active]:bg-transparent data-[state=active]:text-foreground
                 text-muted-foreground font-medium text-[13px] px-4 py-2 -mb-px"
    >
      Chat
    </TabsTrigger>
  </TabsList>
</Tabs>
```

### ScrollArea

Use for all scrollable regions:

```tsx
<ScrollArea className="flex-1">
  {/* content */}
</ScrollArea>
```

---

## Icons

Use **Lucide React** icons exclusively. Common icons:

| Usage | Icon | Size | Stroke |
|-------|------|------|--------|
| New/Add | `Plus` | 12px | 2.5 |
| Settings | `Settings` | 18px | 2 |
| User | `User` | 16px | 2 |
| Close | `X` | 18px | 2 |
| Send | `Send` | 18px | 2 |
| Attach | `Paperclip` | 18px | 2 |
| Mention | `AtSign` | 18px | 2 |
| Folder | `Folder` | 16px | 2 |
| File | `File` | 16px | 2 |
| Code file | `FileCode` | 16px | 2 |
| Image | `Image` | 16px | 2 |
| Chevron right | `ChevronRight` | 12px | 2 |
| Chevron down | `ChevronDown` | 12px | 2 |

---

## Transitions

Use subtle, fast transitions:

```css
transition: all 0.15s ease;
```

Apply to:
- Color changes on hover
- Background changes on hover
- Border color changes on focus

**Do not animate:**
- Layout changes
- Opacity (except status dot pulse)
- Size changes

---

## Accessibility

- All interactive elements need `cursor: pointer`
- Focus states: use `border-color: #1a1a1a` instead of ring
- Labels should be associated with inputs
- Maintain sufficient contrast (WCAG AA minimum)

---

## Anti-patterns to Avoid

❌ **No rounded corners** — not even `rounded-sm`
❌ **No shadows** — no `shadow-sm`, no elevation
❌ **No gradients** — solid colors only
❌ **No colored backgrounds** — white and very light grays only
❌ **No heavy borders** — 1px only
❌ **No animations** — except the status pulse
❌ **No emojis in UI** — keep it typographic
❌ **No ALL CAPS** — except section labels

---

## Reference Mockups

- `zen-app-layout.app.js` — Full three-column layout with all components
- `zen-chat.app.js` — Chat panel detail
- `cast-landing.app.js` — Landing page design

View these on the board to see exact pixel implementation.

---

## Quick Start Checklist

1. [ ] Set `--radius: 0px` in your tailwind/shadcn config
2. [ ] Load Inter font (400, 500, 600 weights)
3. [ ] Set up color variables as specified
4. [ ] Override default shadcn Button, Input, and Tabs styles
5. [ ] Build layout skeleton with fixed sidebar widths
6. [ ] Implement tab component with underline pattern
7. [ ] Build message component with avatar and status
8. [ ] Implement agent roster with three states
9. [ ] Build tree view with indentation levels
10. [ ] Test all hover/focus states

---

*Design by @stroke for Cast. Questions? Ask in #cast-enzos.*
