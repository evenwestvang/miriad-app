---
summary: How to create interactive apps (.app.js) that users can run
---

# Interactive Artifacts (.app.js)

You can create interactive applications as artifacts. When users open these in the artifact pane (next to the chat), they see a "Run" button and can interact with your app live.

## How It Works

Create a code artifact with a `.app.js` extension. The content should be a JavaScript ES module that exports a default object with a `render` function:

```js
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
```

## Runtime Context

The `ctx` object provides:

```js
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
```

**Note:** `ctx.width` and `ctx.height` update automatically when the container resizes. Just read them in your loop - no need to listen for resize events.

## Example: Bouncing Ball

```
artifact_create({
  channel: "my-channel",
  slug: "bouncing-ball.app.js",
  type: "code",
  title: "Bouncing Ball",
  tldr: "A simple bouncing ball animation",
  sender: "your-callsign",
  content: `export default {
  render(container, ctx) {
    container.innerHTML = \`<canvas width="${ctx.width}" height="${ctx.height}"></canvas>\`;
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
}`
})
```

## Key Points

1. **Raw JavaScript**: Content is raw JS code, not wrapped in markdown fences
2. **Always cleanup**: Stop your loops in `cleanup()` or you'll leak memory
3. **Use ctx.loop()**: Don't use setInterval/setTimeout - ctx.loop handles cleanup
4. **Use ctx dimensions**: Don't hardcode sizes - ctx.width/height auto-update on resize
5. **Canvas for graphics**: Use HTML canvas for animations and visualizations
6. **DOM for UI**: You can add buttons, sliders, etc. with standard HTML/DOM

## With UI Controls

```js
export default {
  render(container, ctx) {
    container.innerHTML = `
      <div style="display:flex; gap:1rem; margin-bottom:0.5rem; color:#fff;">
        <label>Speed: <input type="range" id="speed" min="1" max="10" value="5"></label>
        <button id="reset">Reset</button>
      </div>
      <canvas width="${ctx.width}" height="${ctx.height - 40}"></canvas>
    `;

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
```

## Persisting State

Use `ctx.store` to save state across app restarts:

```js
render(container, ctx) {
  let highScore = ctx.store.get('highScore') || 0;

  // ... game logic ...

  if (score > highScore) {
    highScore = score;
    ctx.store.set('highScore', highScore);
  }
}
```

## Fetching Board Artifacts

Your app can fetch other artifacts from the board using `/boards/{channel}/{slug}`:

```js
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
```

The Content-Type is set based on the artifact's file extension:
- `.json` → `application/json`
- `.js` → `text/javascript`
- `.svg` → `image/svg+xml`
- `.md` → `text/markdown`
- `.html` → `text/html`
- `.css` → `text/css`
- `.png`, `.jpg`, `.gif` → appropriate image types
- etc.

This lets you build apps that load data, configurations, or assets from other artifacts on the board. Binary assets uploaded via `upload_asset` are served the same way.

# Loading External Libraries in Interactive Artifacts

You can load any npm package in your `.app.js` artifacts using dynamic imports from **esm.sh** — a CDN that serves npm packages as ES modules.

## Basic Pattern

```js
export default {
  async render(container, ctx) {
    // Load library at runtime
    const THREE = await import('https://esm.sh/three@0.160.0');

    // Use it
    const scene = new THREE.Scene();
  }
}
```

**Key points:**
- Make `render()` an `async` function
- Use `await import('https://esm.sh/package@version')`
- Pin versions for stability (e.g., `three@0.160.0`)

## Common Libraries

### Three.js (3D graphics)
```js
const THREE = await import('https://esm.sh/three@0.160.0');

// With add-ons (OrbitControls, etc.)
const { OrbitControls } = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
```

### D3 (data visualization)
```js
const d3 = await import('https://esm.sh/d3@7');

// Or specific modules
const { scaleLinear, axisBottom } = await import('https://esm.sh/d3@7');
```

### GSAP (animation)
```js
const { gsap } = await import('https://esm.sh/gsap@3');
```

### Chart.js
```js
const { Chart } = await import('https://esm.sh/chart.js@4/auto');
```

### Lodash
```js
const _ = await import('https://esm.sh/lodash-es@4');
```

### Tone.js (audio)
```js
const Tone = await import('https://esm.sh/tone@14');
```

### Matter.js (2D physics)
```js
const Matter = await import('https://esm.sh/matter-js@0.19');
```

## Alternative CDNs

- **esm.sh** (recommended): `https://esm.sh/package@version`
- **Skypack**: `https://cdn.skypack.dev/package@version`
- **jsDelivr**: `https://esm.run/package@version`

## Tips

1. **Pin versions** — Avoid breaking changes: `three@0.160.0` not just `three`

2. **Load once** — Store references if you need them across frames:
   ```js
   // Good: load in render, store on this
   this.THREE = await import('https://esm.sh/three@0.160.0');
   ```

3. **Handle loading state** — Show feedback while loading large libs:
   ```js
   container.innerHTML = '<div style="color:#fff;">Loading Three.js...</div>';
   const THREE = await import('https://esm.sh/three@0.160.0');
   container.innerHTML = ''; // Clear and render
   ```

4. **Check esm.sh docs** — Some packages need special handling: https://esm.sh
