# Scenario 7: Language Design

> A team designs a DSL from scratch, evolving the spec through decisions and examples

## Cast

- **coordinator** - Language architect, maintains spec coherence
- **alfa** - Scout, designs syntax and semantics
- **bravo** - Scout, writes example programs
- **charlie** - Scout, implements parser prototype
- **Human** - Stakeholder, provides requirements and feedback

## Channel: #lang-queryspec

---

## Phase 1: Requirements Gathering

**Human** provides initial requirements:
```
@channel We need a query language for our data API. Something like GraphQL
but simpler. Key requirements:
- Select fields from entities
- Filter with conditions
- Nested relationships
- Type-safe
```

**Coordinator** creates spec artifact:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "spec",
  type: "doc",
  content: `# QuerySpec Language Specification

**Version**: 0.1.0-draft
**Status**: Draft

## Overview
QuerySpec is a typed query language for selecting and filtering data from entities.

## Requirements
- Select fields from entities
- Filter with conditions
- Nested relationships
- Type-safe

## Syntax
*To be defined*

## Semantics
*To be defined*

## Type System
*To be defined*`,
  status: "draft",
  labels: ["spec", "v0.1"]
})
```

---

## Phase 2: Syntax Design

**Alfa** proposes initial syntax:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "proposal-syntax-v1",
  type: "doc",
  content: `## Syntax Proposal v1

### Basic Query
\`\`\`
query User {
  name
  email
}
\`\`\`

### With Filter
\`\`\`
query User where id == 123 {
  name
  email
}
\`\`\`

### Nested
\`\`\`
query User {
  name
  posts {
    title
    createdAt
  }
}
\`\`\`

### Questions
1. Curly braces or indentation-based?
2. \`where\` keyword or inline filters?
3. How to express AND/OR conditions?`,
  parentId: "<spec-id>",
  labels: ["proposal", "syntax"]
})
```

**Coordinator** creates decision artifact:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "decision-brackets",
  type: "decision",
  content: `## Decision: Delimiting Syntax

**Options**:
1. Curly braces: \`query User { name }\`
2. Indentation: \`query User\\n  name\`
3. Parentheses: \`query User ( name )\`

**Decision**: Curly braces

**Rationale**:
- Unambiguous parsing
- Familiar to most developers (JSON, JS, Go)
- Plays nice with copy-paste (no whitespace sensitivity)`,
  parentId: "<spec-id>",
  labels: ["decision"]
})
```

---

## Phase 3: Example Programs

**Bravo** writes example programs as spec evolves:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "example-basic",
  type: "code",
  content: `## Example: Basic Queries

### Select all users
\`\`\`queryspec
query User {
  id
  name
  email
}
\`\`\`

### Filter by ID
\`\`\`queryspec
query User where id == 123 {
  name
  email
}
\`\`\`

### Multiple conditions
\`\`\`queryspec
query User where age > 18 && active == true {
  name
  email
}
\`\`\``,
  parentId: "<spec-id>",
  labels: ["example"]
})

publish_artifact({
  channel: "lang-queryspec",
  name: "example-nested",
  type: "code",
  content: `## Example: Nested Queries

### User with posts
\`\`\`queryspec
query User where id == 123 {
  name
  posts {
    title
    body
    comments {
      author { name }
      text
    }
  }
}
\`\`\`

### With nested filters
\`\`\`queryspec
query User {
  name
  posts where published == true {
    title
  }
}
\`\`\``,
  parentId: "<spec-id>",
  labels: ["example"]
})
```

**Board view**:
```
▼ spec (doc, draft) - QuerySpec Language Specification
  ├─ proposal-syntax-v1 (doc) - Syntax Proposal
  ├─ decision-brackets (decision) - Curly braces
  ├─ example-basic (code) - Basic queries
  └─ example-nested (code) - Nested queries
```

---

## Phase 4: Type System Design

**Alfa** proposes type system:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "proposal-types",
  type: "doc",
  content: `## Type System Proposal

### Primitive Types
- \`String\`
- \`Int\`
- \`Float\`
- \`Bool\`
- \`DateTime\`

### Entity Definition (schema)
\`\`\`queryspec-schema
entity User {
  id: Int
  name: String
  email: String
  createdAt: DateTime
  posts: [Post]
}

entity Post {
  id: Int
  title: String
  body: String
  author: User
}
\`\`\`

### Type Checking Rules
1. Field references must exist in entity
2. Filter comparisons must be type-compatible
3. Nested queries follow relationship types`,
  parentId: "<spec-id>",
  labels: ["proposal", "types"]
})
```

**Coordinator** refines with decision:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "decision-nullable",
  type: "decision",
  content: `## Decision: Nullability

**Question**: How to handle nullable fields?

**Options**:
1. All fields nullable by default
2. All fields non-null by default, \`?\` for nullable
3. Explicit \`nullable\` keyword

**Decision**: Option 2 - Non-null by default

\`\`\`queryspec-schema
entity User {
  name: String     // non-null
  bio: String?     // nullable
}
\`\`\`

**Rationale**: Safer defaults, matches modern type systems (Kotlin, Swift)`,
  parentId: "<proposal-types-id>",
  labels: ["decision"]
})
```

---

## Phase 5: Breaking Change

**Human** feedback:
```
@channel The \`where\` syntax feels verbose for simple cases.
Can we have inline filters like \`User(id: 123)\`?
```

**Coordinator** considers breaking change:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "decision-filter-syntax",
  type: "decision",
  content: `## Decision: Filter Syntax Change

**Current**: \`query User where id == 123 { ... }\`
**Proposed**: \`query User(id: 123) { ... }\`

**BREAKING CHANGE** from proposal-syntax-v1

**Migration**:
\`\`\`
// Old
query User where id == 123 { name }

// New
query User(id: 123) { name }
\`\`\`

**Complex filters** still use \`where\`:
\`\`\`
query User(age: > 18) where active == true && role != "admin" {
  name
}
\`\`\`

**Decision**: Adopt hybrid approach
- Simple equality: \`Entity(field: value)\`
- Complex conditions: \`where\` clause

**Rationale**: Cleaner for common case (90% of queries)`,
  parentId: "<spec-id>",
  labels: ["decision", "breaking-change"]
})
```

**Coordinator** updates spec with edit:

```
edit_artifact({
  channel: "lang-queryspec",
  name: "spec",
  old_string: "**Version**: 0.1.0-draft",
  new_string: "**Version**: 0.2.0-draft"
})
```

**Bravo** updates examples:

```
edit_artifact({
  channel: "lang-queryspec",
  name: "example-basic",
  old_string: "query User where id == 123 {",
  new_string: "query User(id: 123) {"
})

edit_artifact({
  channel: "lang-queryspec",
  name: "example-basic",
  old_string: "query User where age > 18 && active == true {",
  new_string: "query User(age: > 18) where active == true {"
})
```

---

## Phase 6: Parser Prototype

**Charlie** implements parser, creates implementation notes:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "impl-parser",
  type: "code",
  content: `## Parser Implementation

Using PEG grammar. Prototype in TypeScript.

### Grammar (simplified)
\`\`\`peg
Query = "query" EntityName Filters? Where? "{" Fields "}"
EntityName = [A-Z][a-zA-Z]*
Filters = "(" FilterList ")"
FilterList = Filter ("," Filter)*
Filter = FieldName ":" Operator? Value
Where = "where" Condition
Fields = Field+
Field = FieldName Query?
\`\`\`

### Status
- [x] Lexer complete
- [x] Basic parser (no nested queries)
- [ ] Nested query support
- [ ] Type checker

### Test Results
Parsing 1000 queries: 45ms
Memory usage: 12MB peak`,
  parentId: "<spec-id>",
  labels: ["implementation"]
})
```

**Charlie** hits an edge case:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "issue-ambiguous-parse",
  type: "doc",
  content: `## Issue: Ambiguous Parse

### Problem
This query is ambiguous:
\`\`\`queryspec
query User(name: "John (test)") { id }
\`\`\`

The \`)\` inside the string closes the filter prematurely.

### Current Behavior
Parser error: unexpected token

### Proposed Fix
Require escaping: \`"John \\(test\\)"\`
OR use different delimiters for filters: \`query User[name: "John (test)"]\`

### Question for @coordinator
Should we change the delimiter or require escaping?`,
  parentId: "<impl-parser-id>",
  labels: ["bug", "needs-decision"]
})
```

**Coordinator** decides:

```
publish_artifact({
  channel: "lang-queryspec",
  name: "decision-string-escaping",
  type: "decision",
  content: `## Decision: String Escaping

**Issue**: Parentheses in strings break filter parsing

**Options**:
1. Require escaping: \`\\(\` \`\\)\`
2. Square brackets for filters: \`User[name: "value"]\`
3. Different quote types: \`User(name: 'value')\` vs \`"value"\`

**Decision**: Standard backslash escaping (Option 1)

**Rationale**:
- Consistent with most languages
- Parentheses for filters is already established syntax
- Minimal spec change

**Spec Update**: Add to string literal section:
- \`\\\\\` = backslash
- \`\\"\` = quote
- \`\\(\` = open paren
- \`\\)\` = close paren`,
  parentId: "<issue-ambiguous-parse-id>",
  labels: ["decision"]
})
```

---

## Phase 7: Version 1.0

All decisions made, examples validated, parser working.

**Coordinator** promotes spec to v1.0:

```
edit_artifact({
  channel: "lang-queryspec",
  name: "spec",
  old_string: "**Version**: 0.2.0-draft\n**Status**: Draft",
  new_string: "**Version**: 1.0.0\n**Status**: Stable"
})

publish_artifact({
  channel: "lang-queryspec",
  name: "spec",
  type: "doc",
  content: "...",  // Full updated content
  status: "published"  // Upgrade from draft
})
```

**Final Board view** (collapsed):
```
▼ spec (doc, published) - QuerySpec 1.0.0
  ├─ proposal-syntax-v1 (doc)
  ├─ decision-brackets (decision)
  ├─ decision-filter-syntax (decision) [BREAKING]
  ├─ ▼ proposal-types (doc)
  │    └─ decision-nullable (decision)
  ├─ example-basic (code)
  ├─ example-nested (code)
  ├─ ▼ impl-parser (code)
  │    └─ ▼ issue-ambiguous-parse (doc)
  │         └─ decision-string-escaping (decision)
```

**Search** for all breaking changes:
```
list_artifacts({
  channel: "lang-queryspec",
  search: "breaking"
})
```

---

## Design Observations

### What Worked

1. **Hierarchical organization** - Spec at root, everything branches from it
   - Proposals → decisions → examples all linked
   - Easy to trace "why did we decide X?"

2. **Example-driven design** - Examples as code artifacts caught edge cases early

3. **Breaking change tracking** - Labels + decisions document evolution

4. **Draft → Published lifecycle** - Spec stays draft until stable

5. **Search across content** - Finding "breaking" or "nullable" works well

### Gaps Identified - Critical for Language Design

1. **No diff/version history** - Can't see how spec changed between 0.1 and 0.2
   - Language design needs this badly
   - **Suggestion**: `get_artifact_history(channel, name)` returning version list

2. **No artifact linking (non-hierarchical)**
   - Want to say "decision-filter-syntax affects example-basic"
   - parentId only gives tree structure
   - **Suggestion**: `relatedTo: string[]` field for cross-references?

3. **Breaking change impact analysis**
   - When syntax changes, which examples break?
   - Manual today: search + human review
   - **Suggestion**: `dependsOn: string[]` for explicit dependencies?

4. **No artifact templates**
   - Decision artifacts have consistent structure
   - Copy-paste today
   - **Suggestion**: Type-specific templates?

5. **Large content artifacts**
   - Full spec might be 500+ lines
   - `edit_artifact` works but need precise matches
   - **Suggestion**: Line-based edit? `edit_artifact_lines(from, to, newContent)`?

6. **No artifact locking**
   - Two agents editing spec simultaneously = last-write-wins
   - For language spec, want explicit lock
   - **Suggestion**: `lock_artifact` / `unlock_artifact`?

### Scale Observations

At 15 artifacts in this scenario:
- Tree navigation via Board works well
- Search is essential
- parentId hierarchy natural for spec structure

At 100+ artifacts (full language with stdlib docs):
- Would need pagination in `list_artifacts`
- Need better grouping (maybe label-based views)
- Consider: artifact "folders" as first-class concept?

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 12 | Spec, proposals, decisions, examples, impl notes |
| `edit_artifact` | 5 | Version bumps, example updates |
| `list_artifacts` | 2 | Search for breaking changes |
| `update_task_status` | 0 | No formal tasks in this flow |
| `get_artifact` | - | Not needed (tree nav via list) |
| `archive_artifact` | 0 | Old proposals preserved for history |

### New Tools Suggested

| Tool | Purpose |
|------|---------|
| `get_artifact_history` | Version history for diffs |
| `lock_artifact` | Exclusive edit for critical docs |
| `link_artifacts` | Non-hierarchical relationships |
