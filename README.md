# Raid Care Package

**A's chat fills a care package during a raid countdown, then B unboxes those messages live.** It gives the raiding community a fun, visible way to welcome viewers into a new channel.

## How it works

1. Streamer A (the raider) or one of A's moderators opens a 90-second pack window with `!carepack <target>`.
2. Chat adds one note each with `!pack <message>`. Messages are limited to 100 characters, and Twitch emotes are carried into the package.
3. The server asks Twitch to start the raid from A to the target. If Twitch rejects the request, the pack window stays open and A is asked to start the raid manually.
4. When streamer B receives A's raid, B's scene unboxes the saved messages and welcomes the incoming community. Raids without a matching package still get a general welcome.

## Quick start: demo mode

Demo mode needs no `.env`, Twitch login, or Twitch account. It starts the server, then repeatedly simulates the packing countdown, sample chat messages, and raid arrival.

```sh
npm install
npm run demo
```

The server prints these pages when it starts:

- Packing overlay: `http://localhost:3000/overlay/pack`
- Unbox overlay: `http://localhost:3000/overlay/unbox`
- Complete Stream B scene: `http://localhost:3000/scene/b`

Open `/scene/b` to see the daytime scene and unboxing together. Open `/overlay/pack` separately to watch the package fill. The loop repeats automatically.

If another local app already uses port 3000, set `DEMO_PORT` to another free port (for example, `$env:DEMO_PORT=3001` in PowerShell or `DEMO_PORT=3001` in a POSIX shell); the demo prints URLs for the selected port.

## Full Twitch setup

### Register the Twitch application

1. Create an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Set its OAuth Redirect URL to `http://localhost:3000/auth/callback` and choose the appropriate application category.
3. Copy `.env.example` to `.env` and fill in the registered application's client ID and client secret:

   ```dotenv
   TWITCH_CLIENT_ID=your_client_id
   TWITCH_CLIENT_SECRET=your_client_secret
   ```

4. Build and start the local server:

   ```sh
   npm install
   npm run build
   npm start
   ```

5. Visit `http://localhost:3000`. Connect account A as the raiding broadcaster and account B as the receiving broadcaster. Each account authorizes separately.

OAuth requests these scopes:

- `channel:manage:raids` — A can start a raid.
- `user:read:chat` — read each broadcaster's chat through EventSub.
- `user:write:chat` — A can send occasional packing confirmations and manual-raid instructions.

Tokens are stored in local `tokens.json`, refreshed when needed, and excluded from Git. Keep `.env` private too; it is also gitignored.

### OBS setup

Set both streams to 1920 × 1080.

**Streamer A:** add these Browser Sources in order, with the packing overlay above the scene background:

1. `http://localhost:3000/scene/a`
2. `http://localhost:3000/overlay/pack`

Place A's webcam source above the background if you want the camera inside its frame.

**Streamer B:** open `http://localhost:3000/scene/b` in Firefox, press **F11**, then capture the Firefox window in OBS with Window Capture. The page combines B's daytime scene with the transparent unbox overlay and webcam-frame placeholder.

Two OBS instances on one PC may fail to render Browser Sources in the second instance. In that case, use Window Capture of the fullscreen Firefox `/scene/b` page for B.

### Local replay helpers

- `GET http://localhost:3000/debug/demo-pack` starts a local pack countdown and inserts three sample items.
- `GET http://localhost:3000/debug/replay-unbox` replays the last package received in this server session, or a six-item sample if there has not been a package yet.

## Architecture

- One Node.js, TypeScript, and Express server handles both broadcaster accounts and serves the overlay pages.
- EventSub uses a separate WebSocket connection and that broadcaster's user token for each account. A listens for `channel.chat.message`; B listens for `channel.chat.message` and `channel.raid` addressed to B.
- A's `!carepack` command opens the pack window and calls Twitch's Start a raid API. Chat messages and raid notifications are matched against the active package in memory.
- The server sends pack and arrival events to plain HTML/CSS/JavaScript overlays over a local `ws` WebSocket. Overlay pages reconnect if that connection drops.
- Scenes and animations use original HTML, CSS, and SVG artwork with system fonts. Emote images are rendered from Twitch emote IDs in chat messages.
- Demo mode uses the same local overlay WebSocket events but does not load tokens, start EventSub, or call Twitch APIs.
- The project uses no paid APIs or hosted services.

## Development checks

```sh
npm run build
npm test
```

The tests cover one item per user, the 100-character limit, emote parsing, broadcaster/mod authorization, and raid-to-package matching.

## How I built it with Codex

[Placeholder: I will fill in how I used Codex to design, build, and debug Raid Care Package.]
