# FreeQ Chat — Obsidian Plugin

Chat on [FreeQ](https://freeq.at) IRC from inside Obsidian. Clip messages directly into your vault.

---

## Features

- **Real-time IRC chat** via WebSocket — connect to any FreeQ server
- **AT Protocol OAuth** — authenticate with your Bluesky/AT Protocol identity via browser, no app password needed
- **App-password fallback** — works if OAuth setup isn't available
- **Guest mode** — connect without credentials
- **Channel list** with unread badges
- **Member list** toggle
- **Message clipping** — right-click any message to save it into your vault with a customizable template
- **Daily note or folder** clipping destinations
- **IRCv3 support** — `message-tags`, `server-time`, `batch`, `echo-message`, `chathistory`, `away-notify`, `account-notify`, `extended-join`

---

## Installation

### From release (recommended)

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder `.obsidian/plugins/freeq-chat/` in your vault.
3. Copy the three files into that folder.
4. In Obsidian, go to **Settings → Community plugins → Installed plugins**, enable **FreeQ Chat**.

### From source

```bash
cd freeq-obsidian
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/freeq-chat/`.

---

## Authentication

### Option 1: AT Protocol OAuth (recommended)

OAuth lets you log in with your Bluesky/AT Protocol handle without creating an app password.

**One-time setup:**

The OAuth flow requires a small callback page that bridges the browser back to Obsidian. The plugin ships with this page in `docs/oauth-callback.html`.

**Host it on GitHub Pages** (recommended, free):

1. In your repository, go to **Settings → Pages**
2. Set **Source** to "Deploy from a branch", select `main` and folder `/docs`
3. Your callback URL will be:  
   `https://YOUR_USERNAME.github.io/REPO_NAME/oauth-callback.html`
4. Paste this URL into **FreeQ Chat settings → OAuth callback URL**

**Or host it yourself** (Netlify, Vercel, your own server):

Just serve `oauth-callback.html` at any public HTTPS URL and paste it into settings.

**Log in:**

1. Open **Settings → FreeQ Chat**.
2. Under "Log in with AT Protocol", enter your handle (e.g. `alice.bsky.social`).
3. Click **Log in**.
4. A browser window opens. Authorize FreeQ on your PDS.
5. The browser redirects back to Obsidian automatically.
6. You're connected!

### Option 2: App Password (fallback)

If OAuth doesn't work for your setup:

1. Go to [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) and create an app password.
2. In **Settings → FreeQ Chat**, enter your DID/handle and the app password.
3. Click **Connect**.

---

## Usage

### Open the chat sidebar

- Click the **speech-bubble icon** in the left ribbon, or
- Run the command **FreeQ: Open chat sidebar** (`Ctrl/Cmd + P` → "FreeQ: Open chat sidebar")

### Connect

- With OAuth: after login, the plugin auto-connects on next launch.
- With app password: click **Connect** in settings or run **FreeQ: Connect to server**.

### Chat

- Type in the input box and press **Enter** to send.
- Use `/join #channel` to join channels.
- Use `/part` to leave the current channel.
- Use `/me does something` for actions.
- Use `/nick newnick` to change your nick.

### Clip messages

1. **Right-click** any message in the chat view.
2. Select **"Clip message to vault"**.
3. The message is appended to your daily note or a folder note (configurable in settings).

### Templates

In **Settings → FreeQ Chat → Clip template**, customize the template with variables:

| Variable | Description |
|----------|-------------|
| `{{text}}` | Message text |
| `{{from}}` | Sender nick |
| `{{channel}}` | Channel name |
| `{{timestamp}}` | ISO timestamp |
| `{{msgid}}` | Message ULID |
| `{{url}}` | Permalink (server-dependent) |

Default template:

```markdown
> {{text}}
> — @{{from}} in {{channel}}, {{timestamp}}
> [msgid: {{msgid}}]
```

---

## Architecture

This plugin is a lightweight port of the FreeQ web client's IRC stack:

| File | Origin | Notes |
|------|--------|-------|
| `src/irc/parser.ts` | `freeq-app/src/irc/parser.ts` | Unchanged — pure IRC parser |
| `src/irc/transport.ts` | `freeq-app/src/irc/transport.ts` | Unchanged — WebSocket transport |
| `src/irc/client.ts` | Adapted from `freeq-app/src/irc/client.ts` | No React/Zustand; event-emitting class |
| `src/ui/ChatView.ts` | New | Vanilla DOM sidebar view |
| `src/clip/clipper.ts` | New | Obsidian vault writer |
| `src/auth/oauth.ts` | New | OAuth bridge using `obsidian://` protocol |
| `oauth-callback.html` | Inspired by obsidian-atmosphere | Static redirect bridge |

### OAuth Flow

```
┌─────────┐     ┌──────────────┐     ┌──────────┐     ┌─────────────┐
│ Obsidian│────▶│ FreeQ Broker │────▶│ PDS Auth │────▶│   Browser   │
│ (plugin)│     │ /auth/login  │     │  Screen  │     │ (user approves)
└─────────┘     └──────────────┘     └──────────┘     └─────────────┘
     │                                                    │
     │          ┌───────────────┐                         │
     │◄─────────│ oauth-callback│◄────────────────────────┘
     │          │   .html       │   (redirects to obsidian://)
     │          └───────────────┘
     │
     ▼
┌─────────┐
│Obsidian │  registerObsidianProtocolHandler('freeq-chat', ...)
│(plugin) │
└─────────┘
```

1. Plugin opens browser to FreeQ auth broker (`/auth/login?handle=...&return_to=<callback>`)
2. Broker redirects to PDS auth screen
3. User approves → broker redirects to callback page with `#oauth=BASE64`
4. Callback page decodes data and redirects to `obsidian://freeq-chat?oauth=BASE64`
5. Obsidian's protocol handler fires → plugin decodes session → stores broker/web tokens
6. Plugin connects to IRC using refreshed web token via SASL `ATPROTO-CHALLENGE`

---

## Roadmap

- [x] OAuth login via AT Protocol
- [x] App-password fallback
- [ ] Message threads / replies
- [ ] Message edits & deletes
- [ ] Reactions
- [ ] Link previews (OpenGraph)
- [ ] Encrypted DMs (E2EE)
- [ ] Mobile Obsidian optimizations

---

## License

Same as the FreeQ project.
