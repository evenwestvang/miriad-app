export default { render(container, ctx) { const fontLink =
document.createElement('link'); fontLink.href =
'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
fontLink.rel = 'stylesheet'; document.head.appendChild(fontLink);
container.innerHTML = `
<style>
    * {
        box-sizing: border-box;
    }

    .app {
        font-family:
            "Inter",
            -apple-system,
            sans-serif;
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #fff;
        color: #1a1a1a;
    }

    /* Header */
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        height: 48px;
        border-bottom: 1px solid #e5e5e5;
        flex-shrink: 0;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .logo {
        font-weight: 600;
        font-size: 14px;
        letter-spacing: 0.05em;
        color: #de946a;
    }

    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
    }

    .breadcrumb-channel {
        font-weight: 500;
    }

    .breadcrumb-sep {
        color: #ccc;
    }

    .breadcrumb-tagline {
        color: #8c8c8c;
    }

    .header-right {
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .header-icon {
        color: #666;
        cursor: pointer;
        padding: 4px;
    }

    .header-icon:hover {
        color: #1a1a1a;
    }

    .user {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #666;
    }

    .user svg {
        color: #8c8c8c;
    }

    /* Main layout */
    .main {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
        width: 220px;
        border-right: 1px solid #e5e5e5;
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        overflow: hidden;
    }

    .new-channel-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        margin-bottom: 8px;
        font-size: 14px;
        color: #8c8c8c;
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .new-channel-item:hover {
        background: #f5f5f5;
        color: #1a1a1a;
    }

    .sidebar-section {
        padding: 16px 0;
        overflow-y: auto;
        flex: 1;
    }

    .sidebar-label {
        padding: 0 16px 8px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #8c8c8c;
    }

    .channel-list {
        list-style: none;
        margin: 0;
        padding: 0;
    }

    .channel-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px;
        font-size: 14px;
        color: #666;
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .channel-item:hover {
        background: #f5f5f5;
    }

    .channel-item.active {
        background: #f0f0f0;
        color: #1a1a1a;
        font-weight: 500;
    }

    .channel-item.nested {
        padding-left: 32px;
    }

    .channel-hash {
        color: #a0a0a0;
    }

    .channel-chevron {
        margin-left: auto;
        color: #ccc;
    }

    /* Center panel */
    .center-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        border-right: 1px solid #e5e5e5;
        overflow: hidden;
        min-width: 0;
    }

    .panel-tabs {
        display: flex;
        gap: 0;
        padding: 0 16px;
        border-bottom: 1px solid #e5e5e5;
        flex-shrink: 0;
    }

    .panel-tab {
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        color: #8c8c8c;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: all 0.15s ease;
    }

    .panel-tab:hover {
        color: #1a1a1a;
    }

    .panel-tab.active {
        color: #1a1a1a;
        border-bottom-color: #1a1a1a;
    }

    .chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 24px;
    }

    .message {
        display: flex;
        gap: 12px;
        margin-bottom: 24px;
    }

    .msg-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        overflow: hidden;
        flex-shrink: 0;
        margin-top: -6px;
    }

    .msg-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .msg-content {
        flex: 1;
        min-width: 0;
    }

    .msg-header {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 4px;
    }

    .msg-name {
        font-weight: 600;
        font-size: 14px;
    }

    .msg-time {
        font-size: 12px;
        color: #8c8c8c;
    }

    .msg-role {
        font-size: 12px;
        color: #a0a0a0;
    }

    .msg-body {
        font-size: 14px;
        line-height: 1.5;
        color: #2c2c2c;
    }

    .msg-body p {
        margin: 0 0 8px;
    }

    .msg-body p:last-child {
        margin: 0;
    }

    /* Input area */
    .chat-input-area {
        padding: 16px 24px;
        border-top: 1px solid #f0f0f0;
        flex-shrink: 0;
    }

    .mentions-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 12px;
        color: #8c8c8c;
    }

    .agent-roster {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .roster-agent {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        cursor: pointer;
        transition: opacity 0.15s ease;
    }

    .roster-agent:hover {
        opacity: 0.8;
    }

    .roster-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    /* Actively working - pulsing orange */
    .roster-agent.working .roster-dot {
        background: #de946a;
        animation: pulse 2s ease-in-out infinite;
    }

    .roster-agent.working .roster-name {
        color: #de946a;
    }

    /* Attentive/waiting - solid orange, no pulse */
    .roster-agent.attentive .roster-dot {
        background: #de946a;
    }

    .roster-agent.attentive .roster-name {
        color: #de946a;
    }

    /* Idle/standby - muted gray */
    .roster-agent.idle .roster-dot {
        background: #c0c0c0;
    }

    .roster-agent.idle .roster-name {
        color: #a0a0a0;
    }

    .roster-name {
        transition: color 0.15s ease;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
            transform: scale(1);
        }
        50% {
            opacity: 0.5;
            transform: scale(1.2);
        }
    }

    .input-box {
        border: 1px solid #e5e5e5;
        transition: border-color 0.15s ease;
    }

    .input-box:focus-within {
        border-color: #1a1a1a;
    }

    .input-field {
        width: 100%;
        padding: 12px;
        border: none;
        outline: none;
        font-family: inherit;
        font-size: 14px;
        resize: none;
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

    .input-btn {
        background: none;
        border: none;
        padding: 4px;
        color: #8c8c8c;
        cursor: pointer;
    }

    .input-btn:hover {
        color: #1a1a1a;
    }

    .add-agent-inline {
        display: flex;
        align-items: center;
        gap: 4px;
        background: none;
        border: none;
        font-family: inherit;
        font-size: 12px;
        color: #a0a0a0;
        cursor: pointer;
        padding: 0;
        transition: color 0.15s ease;
    }

    .add-agent-inline:hover {
        color: #1a1a1a;
    }

    /* Right panel */
    .right-panel {
        width: 320px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex-shrink: 0;
    }

    .right-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 16px;
        border-bottom: 1px solid #e5e5e5;
    }

    .right-panel-tabs {
        display: flex;
        gap: 0;
    }

    .right-panel-tab {
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        color: #8c8c8c;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: all 0.15s ease;
    }

    .right-panel-tab:hover {
        color: #1a1a1a;
    }

    .right-panel-tab.active {
        color: #1a1a1a;
        border-bottom-color: #1a1a1a;
    }

    .right-panel-close {
        background: none;
        border: none;
        padding: 4px;
        color: #8c8c8c;
        cursor: pointer;
    }

    .right-panel-close:hover {
        color: #1a1a1a;
    }

    .tree-container {
        flex: 1;
        overflow-y: auto;
        padding: 12px 0;
    }

    .tree-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 16px;
        font-size: 13px;
        color: #666;
        cursor: pointer;
    }

    .tree-item:hover {
        background: #f5f5f5;
    }

    .tree-item.depth-1 {
        padding-left: 28px;
    }
    .tree-item.depth-2 {
        padding-left: 44px;
    }
    .tree-item.depth-3 {
        padding-left: 60px;
    }

    .tree-icon {
        color: #a0a0a0;
        flex-shrink: 0;
    }

    .tree-label {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tree-chevron {
        color: #ccc;
    }
</style>

<div class="app">
    <header class="header">
        <div class="header-left">
            <div class="logo">CAST</div>
            <div class="breadcrumb">
                <span class="breadcrumb-channel"># cast-enzos</span>
                <span class="breadcrumb-sep">—</span>
                <span class="breadcrumb-tagline">Open workspace</span>
            </div>
        </div>
        <div class="header-right">
            <div class="user">
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <circle cx="12" cy="8" r="4" />
                    <path d="M20 21a8 8 0 1 0-16 0" />
                </svg>
                <span>simen</span>
            </div>
            <svg
                class="header-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <circle cx="12" cy="12" r="3" />
                <path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                />
            </svg>
        </div>
    </header>

    <div class="main">
        <aside class="sidebar">
            <div class="sidebar-section">
                <div class="new-channel-item">
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                    >
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New Channel
                </div>
                <div class="sidebar-label">Channels</div>
                <ul class="channel-list">
                    <li class="channel-item active">
                        <span class="channel-hash">#</span> cast-enzos
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> cikada-billing
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> cikada-avatar-design
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> dev-mcp
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> cikada-wiring
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> competitive-analysis
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> kb-sanity-platform
                        <svg
                            class="channel-chevron"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> sanity-mag
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> cast-the-story
                    </li>
                    <li class="channel-item">
                        <span class="channel-hash">#</span> infra-survey
                    </li>
                </ul>
            </div>
        </aside>

        <main class="center-panel">
            <div class="panel-tabs">
                <div class="panel-tab active">Chat</div>
                <div class="panel-tab">Mission</div>
            </div>

            <div class="chat-messages">
                <div class="message">
                    <div class="msg-avatar" id="avatar-owl"></div>
                    <div class="msg-content">
                        <div class="msg-header">
                            <span class="msg-name">owl</span>
                            <span class="msg-time">7:32 AM</span>
                            <span class="msg-role"
                                >builder – refactoring auth flow</span
                            >
                        </div>
                        <div class="msg-body">
                            <p>
                                I've been reviewing the authentication flow and
                                found a few edge cases we should handle.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="message">
                    <div class="msg-avatar" id="avatar-bear"></div>
                    <div class="msg-content">
                        <div class="msg-header">
                            <span class="msg-name">bear</span>
                            <span class="msg-time">7:43 AM</span>
                            <span class="msg-role"
                                >ux designer – aligning with prototype</span
                            >
                        </div>
                        <div class="msg-body">
                            <p>
                                Makes sense. I'll update the flow diagram to
                                reflect the new requirements.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="message">
                    <div class="msg-avatar" id="avatar-fox"></div>
                    <div class="msg-content">
                        <div class="msg-header">
                            <span class="msg-name">fox</span>
                            <span class="msg-time">8:01 AM</span>
                            <span class="msg-role"
                                >reviewer – waiting for build</span
                            >
                        </div>
                        <div class="msg-body">
                            <p>
                                I can help with the mutex implementation. Let's
                                sync after standup.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="chat-input-area">
                <div class="mentions-bar">
                    <div class="agent-roster">
                        <div class="roster-agent working">
                            <span class="roster-dot"></span>
                            <span class="roster-name">owl</span>
                        </div>
                        <div class="roster-agent attentive">
                            <span class="roster-dot"></span>
                            <span class="roster-name">bear</span>
                        </div>
                        <div class="roster-agent attentive">
                            <span class="roster-dot"></span>
                            <span class="roster-name">fox</span>
                        </div>
                        <div class="roster-agent idle">
                            <span class="roster-dot"></span>
                            <span class="roster-name">lead</span>
                        </div>
                        <div class="roster-agent idle">
                            <span class="roster-dot"></span>
                            <span class="roster-name">stroke</span>
                        </div>
                    </div>
                    <button class="add-agent-inline">
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                        >
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add agent
                    </button>
                </div>
                <div class="input-box">
                    <textarea
                        class="input-field"
                        rows="1"
                        placeholder="Message the team..."
                    ></textarea>
                    <div class="input-actions">
                        <div class="input-actions-left">
                            <button class="input-btn">
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                >
                                    <path
                                        d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                                    />
                                </svg>
                            </button>
                            <button class="input-btn">
                                <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                >
                                    <circle cx="12" cy="12" r="4" />
                                    <path
                                        d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"
                                    />
                                </svg>
                            </button>
                        </div>
                        <button class="input-btn">
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                            >
                                <path d="m22 2-7 20-4-9-9-4Z" />
                                <path d="M22 2 11 13" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </main>

        <aside class="right-panel">
            <div class="right-panel-header">
                <div class="right-panel-tabs">
                    <div class="right-panel-tab active">Board</div>
                    <div class="right-panel-tab">Firehose</div>
                </div>
                <button class="right-panel-close">
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            <div class="tree-container">
                <div class="tree-item">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                        />
                    </svg>
                    <span class="tree-label">Design Artifacts</span>
                    <svg
                        class="tree-chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </div>
                <div class="tree-item depth-1">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
                        />
                        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                    </svg>
                    <span class="tree-label">app-layout-spec</span>
                </div>
                <div class="tree-item depth-1">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
                        />
                        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                        <path d="m10 13-2 2 2 2" />
                        <path d="m14 17 2-2-2-2" />
                    </svg>
                    <span class="tree-label">zen-chat.app.js</span>
                </div>

                <div class="tree-item">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                        />
                    </svg>
                    <span class="tree-label">Generated Assets</span>
                    <svg
                        class="tree-chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </div>
                <div class="tree-item depth-1">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <rect
                            width="18"
                            height="18"
                            x="3"
                            y="3"
                            rx="2"
                            ry="2"
                        />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <span class="tree-label">enso-v2-crimson.png</span>
                </div>
                <div class="tree-item depth-1">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <rect
                            width="18"
                            height="18"
                            x="3"
                            y="3"
                            rx="2"
                            ry="2"
                        />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <span class="tree-label">dry-brush-indigo.png</span>
                </div>
                <div class="tree-item depth-1">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <rect
                            width="18"
                            height="18"
                            x="3"
                            y="3"
                            rx="2"
                            ry="2"
                        />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <span class="tree-label">watercolor-v3-crimson.png</span>
                </div>

                <div class="tree-item">
                    <svg
                        class="tree-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                        />
                    </svg>
                    <span class="tree-label">Reference</span>
                    <svg
                        class="tree-chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <polyline points="9 18 15 12 9 6" />
                    </svg>
                </div>
            </div>
        </aside>
    </div>
</div>
`; // Load ensō avatars const avatars = { owl:
'/boards/cast-enzos/enso-v2-crimson.png', bear:
'/boards/cast-enzos/dry-brush-indigo.png', fox:
'/boards/cast-enzos/watercolor-v3-crimson.png' };
Object.entries(avatars).forEach(([name, src]) => { const el =
container.querySelector(`#avatar-${name}`); if (el) { el.innerHTML = `<img
    src="${src}"
    alt="${name}"
/>`; } }); }, cleanup() {} }
