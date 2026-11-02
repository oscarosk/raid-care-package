# Raid Care Package

Project context for contributors and coding agents.

## Product

Raid Care Package is a Codex x TwitchCon Hackathon project. When streamer A raids streamer B, A's chat packs a care package during the raid countdown, and it is unboxed live on B's stream.

## Stack and constraints

- Node.js + TypeScript, Express, and `ws` for overlay WebSockets.
- Twitch EventSub over WebSocket.
- Plain HTML/CSS/JS OBS Browser Source overlays.
- One local server handles broadcaster accounts A and B.
- No paid APIs. Keep credentials in `.env`; never commit tokens or secrets.

## Build order

1. Two-account OAuth authorization code flow, token persistence/refresh, and EventSub chat/raid subscriptions.
2. Packing commands and raid start flow.
3. Arrival handling and overlays.
4. Demo mode and complete setup/OBS documentation.

Keep changes focused on the current step. Verify each step before starting the next, and keep commits small.
