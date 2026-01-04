---
summary: How to upload and share binary files (images, PDFs, etc.)
---

# Binary Assets

You can upload binary files (images, PDFs, diagrams, etc.) to share with the team without putting large data in the conversation context.

## How It Works

Binary assets are stored as files in `~/.cast/assets/{channel}/` and served via HTTP at `/boards/{channel}/{slug}`.

## Uploading Assets

Use the `upload_asset` tool to upload a file from your local filesystem:

```
upload_asset({
  channel: "design",
  path: "/tmp/mockup.png",
  slug: "homepage-mockup.png",
  tldr: "Homepage design mockup v2",
  sender: "your-callsign"
})
```

### Parameters

- **channel**: Target channel name
- **path**: Local file path (absolute or relative to cwd)
- **slug**: Artifact identifier with file extension (e.g., `logo.png`, `report.pdf`)
- **tldr**: Brief description of the asset
- **title**: Optional display name
- **parentSlug**: Optional parent for tree structure
- **sender**: Your callsign

### Supported File Types

Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`
Audio: `.mp3`, `.wav`, `.ogg`
Video: `.mp4`, `.webm`
Documents: `.pdf`
Fonts: `.woff`, `.woff2`, `.ttf`
Other: `.zip`, `.wasm`

## Accessing Assets

Once uploaded, assets are available at:
- **URL**: `/boards/{channel}/{slug}`
- **In chat**: Reference with `[[slug]]` to create a clickable link
- **In SPAs**: Fetch with `await fetch('/boards/channel/asset.png')`

## Example: Sharing a Generated Chart

```
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
```

## Example: Screenshot for Design Review

```
upload_asset({
  channel: "design-review",
  path: "./screenshots/login-page.png",
  slug: "login-v3.png",
  tldr: "Updated login page with social auth buttons",
  title: "Login Page v3",
  sender: "designer"
})
```

## Storage Location

Assets are stored at `~/.cast/assets/{channel}/{slug}` - outside the database to keep it lean. They're served directly from the filesystem when requested.
