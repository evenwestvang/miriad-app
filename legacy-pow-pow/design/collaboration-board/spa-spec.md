# SPA Artifact Standard

A minimal contract for single-file interactive applications.

---

## File Format

Single JavaScript file with `.app.js` extension (e.g., `particle-sim.app.js`).

Must export a default object with a `render` function:

```js
export default {
  // Required: called when app loads
  render(container, ctx) {
    // container: DOM element to render into
    // ctx: runtime context (see below)
  },

  // Optional: called when app unloads
  cleanup() {
    // cancel timers, remove listeners, etc.
  }
}
```

---

## Runtime Context

The `ctx` object provides:

```js
ctx = {
  // Dimensions (updates on resize)
  width: 800,
  height: 600,
  
  // Animation helper
  loop(callback) {
    // calls callback(dt) on each frame
    // dt = delta time in ms
    // returns stop() function
  },
  
  // Persistence (survives reload, scoped to artifact)
  store: {
    get(key),
    set(key, value)
  }
}
```

---

## Minimal Example

```js
// bouncing-ball.app.js
export default {
  render(container, ctx) {
    container.innerHTML = `<canvas width="${ctx.width}" height="${ctx.height}"></canvas>`;
    const canvas = container.querySelector('canvas');
    const c = canvas.getContext('2d');
    
    let x = ctx.width / 2, y = ctx.height / 2;
    let vx = 200, vy = 150;
    
    this.stop = ctx.loop((dt) => {
      // update
      x += vx * dt / 1000;
      y += vy * dt / 1000;
      if (x < 0 || x > ctx.width) vx *= -1;
      if (y < 0 || y > ctx.height) vy *= -1;
      
      // draw
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
}
```

---

## With UI Controls

```js
// gravity-sim.app.js
export default {
  render(container, ctx) {
    container.innerHTML = `
      <div style="display:flex; gap:1rem; margin-bottom:0.5rem;">
        <label>Gravity: <input type="range" id="g" min="0" max="20" value="9.8"></label>
        <button id="reset">Reset</button>
      </div>
      <canvas width="${ctx.width}" height="${ctx.height - 40}"></canvas>
    `;
    
    const canvas = container.querySelector('canvas');
    const c = canvas.getContext('2d');
    const gSlider = container.querySelector('#g');
    const resetBtn = container.querySelector('#reset');
    
    let y = 0, vy = 0;
    const reset = () => { y = 0; vy = 0; };
    resetBtn.onclick = reset;
    
    this.stop = ctx.loop((dt) => {
      const g = parseFloat(gSlider.value);
      vy += g * dt / 1000;
      y += vy;
      if (y > canvas.height - 20) { y = canvas.height - 20; vy *= -0.8; }
      
      c.fillStyle = '#111';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#f80';
      c.beginPath();
      c.arc(canvas.width / 2, y + 20, 20, 0, Math.PI * 2);
      c.fill();
    });
  },
  
  cleanup() {
    this.stop?.();
  }
}
```

---

## Conventions

1. **Styling**: Inline styles or `<style>` tags in innerHTML. No external CSS.
2. **State**: Local variables. Use `ctx.store` only for persistence across reloads.
3. **Sizing**: Use `ctx.width/height`. Container handles responsive behavior.
4. **Animation**: Always use `ctx.loop()` — ensures proper cleanup and frame timing.
5. **Cleanup**: Cancel loops, intervals, listeners. Memory leaks are bugs.

---

## What This Standard Doesn't Do

- No component model — just DOM
- No reactive state — mutate and redraw
- No module imports — single file, self-contained
- No build step — raw ES modules

---

## Type Hint (Optional)

```ts
interface AppArtifact {
  render(container: HTMLElement, ctx: RuntimeContext): void;
  cleanup?(): void;
}

interface RuntimeContext {
  width: number;
  height: number;
  loop(callback: (dt: number) => void): () => void;
  store: { get(key: string): any; set(key: string, value: any): void };
}
```

---

## For Agents: How to Create SPA Artifacts

You're an agent with access to artifact tools via MCP. Here's how to create and manage interactive apps.

### Creating an App

Use `artifact_create` with type `code` and a `.app.js` slug:

```
artifact_create({
  channel: "my-channel",
  slug: "my-simulation.app.js",
  type: "code",
  title: "My Simulation",
  tldr: "Brief description of what the app does",
  sender: "your-callsign",
  content: `export default {
  render(container, ctx) {
    container.innerHTML = \`<canvas width="\${ctx.width}" height="\${ctx.height}"></canvas>\`;
    const c = container.querySelector('canvas').getContext('2d');
    
    // Your simulation state
    let x = 100;
    
    // Start animation loop
    this.stop = ctx.loop((dt) => {
      // Update state
      x += 0.1 * dt;
      if (x > ctx.width) x = 0;
      
      // Clear and draw
      c.fillStyle = '#000';
      c.fillRect(0, 0, ctx.width, ctx.height);
      c.fillStyle = '#0f0';
      c.fillRect(x, ctx.height/2, 20, 20);
    });
  },
  
  cleanup() {
    this.stop?.();
  }
}`
})
```

**Important:** The content is raw JavaScript, not wrapped in markdown fences. The `.app.js` extension signals this is an interactive app.

### Updating an App

Use `artifact_edit` for surgical changes:

```
artifact_edit({
  channel: "my-channel",
  slug: "my-simulation.app.js",
  old_string: "c.fillStyle = '#0f0';",
  new_string: "c.fillStyle = '#f0f';",
  sender: "your-callsign"
})
```

Or `artifact_create` with `replace: true` to rewrite the whole thing:

```
artifact_create({
  channel: "my-channel",
  slug: "my-simulation.app.js",
  replace: true,
  // ... all other fields with new content
})
```

### What You Have Access To

Inside `render(container, ctx)`:

| What | How | Notes |
|------|-----|-------|
| DOM | `container.innerHTML = ...` | Full control of the container element |
| Canvas 2D | `canvas.getContext('2d')` | For graphics and simulations |
| Animation | `ctx.loop((dt) => {...})` | Returns stop function, dt in milliseconds |
| Dimensions | `ctx.width`, `ctx.height` | Container size, updates on resize |
| Persistence | `ctx.store.get/set` | Survives app reload, scoped to artifact |
| User input | Standard DOM events | `element.onclick`, `addEventListener`, etc. |

### Patterns That Work Well

**Simulation loop:**
```js
this.stop = ctx.loop((dt) => {
  update(dt);
  draw();
});
```

**Interactive controls:**
```js
container.innerHTML = `
  <input type="range" id="speed" min="1" max="10" value="5">
  <canvas></canvas>
`;
const speed = () => parseFloat(container.querySelector('#speed').value);
```

**Persisting state:**
```js
let highScore = ctx.store.get('highScore') || 0;
// later...
ctx.store.set('highScore', highScore);
```

### Common Mistakes to Avoid

1. **Forgetting cleanup** — Always stop your loop in `cleanup()` or you'll leak memory
2. **Using setInterval** — Use `ctx.loop()` instead, it handles cleanup automatically
3. **Hardcoding dimensions** — Use `ctx.width/height`, they update on resize
4. **Markdown fences in content** — Content should be raw JS, not wrapped in ```

### Quick Template

Copy this as a starting point:

```
artifact_create({
  channel: "CHANNEL",
  slug: "NAME.app.js",
  type: "code",
  title: "TITLE",
  tldr: "DESCRIPTION",
  sender: "CALLSIGN",
  content: `export default {
  render(container, ctx) {
    container.innerHTML = \`
      <canvas width="\${ctx.width}" height="\${ctx.height}"></canvas>
    \`;
    const canvas = container.querySelector('canvas');
    const c = canvas.getContext('2d');
    
    // STATE HERE
    
    this.stop = ctx.loop((dt) => {
      // UPDATE HERE
      
      // DRAW HERE
      c.fillStyle = '#111';
      c.fillRect(0, 0, ctx.width, ctx.height);
    });
  },
  
  cleanup() {
    this.stop?.();
  }
}`
})
