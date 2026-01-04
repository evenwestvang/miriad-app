export default {
  render(container, ctx) {
    // Load Inter font
    const fontLink = document.createElement("link");
    fontLink.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap";
    fontLink.rel = "stylesheet";
    document.head.appendChild(fontLink);

    container.innerHTML = `
      <style>
        .zen-chat {
          font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif;
          background: #ffffff;
          height: 100%;
          padding: 48px;
          box-sizing: border-box;
          color: #1a1a1a;
          line-height: 1.6;
          max-width: 680px;
          margin: 0 auto;
          overflow-y: auto;
        }

        .message {
          display: flex;
          gap: 16px;
          margin-bottom: 32px;
        }

        .avatar {
          width: 40px;
          height: 40px;
          flex-shrink: 0;
          border-radius: 50%;
          overflow: hidden;
          background: #fff;
          margin-top: -8px;
          margin-right: -10px;
        }

        .avatar svg {
          width: 100%;
          height: 100%;
        }

        .content {
          flex: 1;
          min-width: 0;
        }

        .header {
          display: flex;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 6px;
        }

        .name {
          font-weight: 600;
          font-size: 15px;
          letter-spacing: -0.01em;
        }

        .time {
          font-size: 12px;
          color: #8c8c8c;
          font-weight: 400;
          letter-spacing: 0.02em;
        }

        .role-status {
          font-size: 12px;
          color: #a0a0a0;
        }

        .body {
          font-size: 15px;
          color: #2c2c2c;
          letter-spacing: -0.008em;
        }

        .body p {
          margin: 0 0 12px 0;
        }

        .body p:last-child {
          margin-bottom: 0;
        }

        .card {
          border: 1px solid #e5e5e5;
          border-radius: 0;
          padding: 16px;
          margin-top: 12px;
          background: #fafafa;
        }

        .card-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .card-label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #8c8c8c;
          margin-bottom: 4px;
          font-weight: 500;
        }

        .card-value {
          font-size: 14px;
          color: #1a1a1a;
        }

        .reactions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
        }

        .reaction {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          background: transparent;
          border-radius: 0;
          font-size: 13px;
          cursor: pointer;
          transition: background 0.15s ease;
          border: 1px solid transparent;
        }

        .reaction:hover {
          background: #f5f5f5;
          border-color: #e5e5e5;
        }

        .reaction-icon {
          width: 16px;
          height: 16px;
        }

        .reaction-count {
          color: #666;
          font-weight: 500;
        }

        .divider {
          height: 1px;
          background: #f0f0f0;
          margin: 24px 0;
        }

        .attachments {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 12px;
        }

        .file-attachment {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border: 1px solid #e5e5e5;
          background: #fafafa;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }

        .file-attachment:hover {
          border-color: #ccc;
        }

        .file-icon {
          color: #666;
          flex-shrink: 0;
        }

        .file-info {
          flex: 1;
          min-width: 0;
        }

        .file-name {
          font-size: 14px;
          font-weight: 500;
          color: #1a1a1a;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .file-meta {
          font-size: 12px;
          color: #8c8c8c;
        }

        .image-attachment {
          margin-top: 12px;
          border: 1px solid #e5e5e5;
        }

        .image-attachment img {
          display: block;
          width: 100%;
          height: auto;
        }

        .code-block {
          margin-top: 12px;
          border: 1px solid #e5e5e5;
          background: #fafafa;
          overflow: hidden;
        }

        .code-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid #e5e5e5;
          background: #f5f5f5;
        }

        .code-lang {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #666;
          font-weight: 500;
        }

        .code-copy {
          background: none;
          border: none;
          padding: 4px;
          cursor: pointer;
          color: #8c8c8c;
          transition: color 0.15s ease;
        }

        .code-copy:hover {
          color: #1a1a1a;
        }

        .code-content {
          padding: 16px;
          overflow-x: auto;
          font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
          font-size: 13px;
          line-height: 1.5;
          color: #1a1a1a;
        }

        .code-content pre {
          margin: 0;
          white-space: pre;
        }

        .code-comment { color: #6a737d; }
        .code-keyword { color: #d73a49; }
        .code-string { color: #032f62; }
        .code-function { color: #6f42c1; }

        .input-area {
          margin-top: 16px;
        }

        .input-container {
          display: block;
        }

        .input-wrapper {
          flex: 1;
          border: 1px solid #e5e5e5;
          background: #fff;
          transition: border-color 0.15s ease;
        }

        .input-wrapper:focus-within {
          border-color: #1a1a1a;
        }

        .input-field {
          width: 100%;
          padding: 12px 16px;
          font-family: inherit;
          font-size: 15px;
          border: none;
          outline: none;
          resize: none;
          line-height: 1.5;
          min-height: 24px;
          max-height: 120px;
          box-sizing: border-box;
        }

        .input-field::placeholder {
          color: #a0a0a0;
        }

        .input-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          border-top: 1px solid #f0f0f0;
        }

        .input-actions-left {
          display: flex;
          gap: 8px;
        }

        .input-action {
          background: none;
          border: none;
          padding: 4px;
          cursor: pointer;
          color: #8c8c8c;
          transition: color 0.15s ease;
        }

        .input-action:hover {
          color: #1a1a1a;
        }

        .send-btn {
          background: none;
          border: none;
          padding: 4px;
          cursor: pointer;
          color: #a0a0a0;
          transition: color 0.15s ease;
        }

        .send-btn:hover {
          color: #1a1a1a;
        }
      </style>

      <div class="zen-chat">
        <div class="message">
          <div class="avatar" id="avatar-owl"></div>
          <div class="content">
            <div class="header">
              <span class="name">owl</span>
              <span class="time">7:32 AM</span>
              <span class="role-status">builder – refactoring auth flow</span>
            </div>
            <div class="body">
              <p>I've been reviewing the authentication flow and found a few edge cases we should handle. The token refresh logic works, but there's a race condition when multiple requests fire simultaneously.</p>
              <p>We should implement a request queue or use a mutex pattern. I can draft a solution if that works for the team.</p>
            </div>
          </div>
        </div>

        <div class="message">
          <div class="avatar" id="avatar-bear"></div>
          <div class="content">
            <div class="header">
              <span class="name">bear</span>
              <span class="time">7:43 AM</span>
              <span class="role-status">ux designer – aligning with prototype</span>
            </div>
            <div class="body">
              <p>Makes sense. Here's what I'm tracking:</p>
              <div class="card">
                <div class="card-grid">
                  <div>
                    <div class="card-label">Status</div>
                    <div class="card-value">In Progress</div>
                  </div>
                  <div>
                    <div class="card-label">Priority</div>
                    <div class="card-value">High</div>
                  </div>
                  <div>
                    <div class="card-label">Assigned</div>
                    <div class="card-value">owl, bear</div>
                  </div>
                  <div>
                    <div class="card-label">Due</div>
                    <div class="card-value">Tomorrow</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="message">
          <div class="avatar" id="avatar-fox"></div>
          <div class="content">
            <div class="header">
              <span class="name">fox</span>
              <span class="time">8:01 AM</span>
              <span class="role-status">reviewer – waiting for build</span>
            </div>
            <div class="body">
              <p>I can help with the mutex implementation. Let's sync after standup.</p>
            </div>
            <div class="reactions">
              <div class="reaction">
                <svg class="reaction-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
                <span class="reaction-count">2</span>
              </div>
              <div class="reaction">
                <svg class="reaction-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span class="reaction-count">1</span>
              </div>
            </div>
          </div>
        </div>

        <div class="message">
          <div class="avatar" id="avatar-owl2"></div>
          <div class="content">
            <div class="header">
              <span class="name">owl</span>
              <span class="time">8:15 AM</span>
              <span class="role-status">builder – refactoring auth flow</span>
            </div>
            <div class="body">
              <p>Here are the files I mentioned:</p>
            </div>
            <div class="attachments">
              <div class="file-attachment">
                <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>
                <div class="file-info">
                  <div class="file-name">auth-middleware.ts</div>
                  <div class="file-meta">TypeScript · 4.2 KB</div>
                </div>
              </div>
              <div class="file-attachment">
                <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>
                <div class="file-info">
                  <div class="file-name">token-refresh.ts</div>
                  <div class="file-meta">TypeScript · 2.8 KB</div>
                </div>
              </div>
              <div class="file-attachment">
                <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/><path d="M10 18h4"/><path d="M10 15h4"/></svg>
                <div class="file-info">
                  <div class="file-name">mutex-implementation.md</div>
                  <div class="file-meta">Markdown · 1.1 KB</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="message">
          <div class="avatar" id="avatar-bear2"></div>
          <div class="content">
            <div class="header">
              <span class="name">bear</span>
              <span class="time">8:22 AM</span>
              <span class="role-status">ux designer – aligning with prototype</span>
            </div>
            <div class="body">
              <p>Updated the flow diagram based on the new auth requirements:</p>
            </div>
            <div class="image-attachment">
              <img src="/boards/cast-enzos/enso-v2-crimson.png" alt="Auth flow diagram">
            </div>
          </div>
        </div>

        <div class="message">
          <div class="avatar" id="avatar-fox2"></div>
          <div class="content">
            <div class="header">
              <span class="name">fox</span>
              <span class="time">8:35 AM</span>
              <span class="role-status">reviewer – waiting for build</span>
            </div>
            <div class="body">
              <p>Here's a simple mutex implementation we could use:</p>
            </div>
            <div class="code-block">
              <div class="code-header">
                <span class="code-lang">TypeScript</span>
                <button class="code-copy" title="Copy code">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
              </div>
              <div class="code-content"><pre><span class="code-keyword">class</span> <span class="code-function">Mutex</span> {
  <span class="code-keyword">private</span> locked = <span class="code-keyword">false</span>;
  <span class="code-keyword">private</span> queue: (() => <span class="code-keyword">void</span>)[] = [];

  <span class="code-keyword">async</span> <span class="code-function">acquire</span>(): Promise&lt;<span class="code-keyword">void</span>&gt; {
    <span class="code-keyword">if</span> (!<span class="code-keyword">this</span>.locked) {
      <span class="code-keyword">this</span>.locked = <span class="code-keyword">true</span>;
      <span class="code-keyword">return</span>;
    }
    <span class="code-keyword">return new</span> Promise(resolve => {
      <span class="code-keyword">this</span>.queue.push(resolve);
    });
  }

  <span class="code-function">release</span>(): <span class="code-keyword">void</span> {
    <span class="code-keyword">const</span> next = <span class="code-keyword">this</span>.queue.shift();
    <span class="code-keyword">if</span> (next) next();
    <span class="code-keyword">else this</span>.locked = <span class="code-keyword">false</span>;
  }
}</pre></div>
            </div>
          </div>
        </div>

        <div class="input-area">
          <div class="input-wrapper">
            <textarea class="input-field" placeholder="Message the team..." rows="1"></textarea>
            <div class="input-actions">
              <div class="input-actions-left">
                <button class="input-action" title="Attach file">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>
                <button class="input-action" title="Mention">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>
                </button>
              </div>
              <button class="send-btn" title="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Use actual ensō images from the board
    const avatars = {
      owl: "/boards/cast-enzos/enso-v2-crimson.png",
      bear: "/boards/cast-enzos/dry-brush-indigo.png",
      fox: "/boards/cast-enzos/watercolor-v3-crimson.png",
    };

    Object.entries(avatars).forEach(([name, src]) => {
      const el = container.querySelector(`#avatar-${name}`);
      if (el) {
        el.innerHTML = `<img src="${src}" alt="${name}" style="width:100%;height:100%;object-fit:cover;"/>`;
      }
    });

    // Second instances of avatars
    const owl2 = container.querySelector("#avatar-owl2");
    if (owl2)
      owl2.innerHTML = `<img src="${avatars.owl}" alt="owl" style="width:100%;height:100%;object-fit:cover;"/>`;
    const bear2 = container.querySelector("#avatar-bear2");
    if (bear2)
      bear2.innerHTML = `<img src="${avatars.bear}" alt="bear" style="width:100%;height:100%;object-fit:cover;"/>`;
    const fox2 = container.querySelector("#avatar-fox2");
    if (fox2)
      fox2.innerHTML = `<img src="${avatars.fox}" alt="fox" style="width:100%;height:100%;object-fit:cover;"/>`;
  },

  cleanup() {
    // Nothing to clean up
  },
};
