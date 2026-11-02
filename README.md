# Raid Care Package

Raid Care Package is a TwitchCon hackathon demo: when streamer A raids streamer B, A's chat packs a care package during the countdown, and it is unboxed live on B's stream.

## Current build

OAuth, EventSub, packing, raid arrival, and both overlays are implemented. Connect account A (raider) and account B (receiving broadcaster) at `http://localhost:3000`. The server uses one EventSub WebSocket per account and logs tagged notifications in the terminal.

## Setup

1. Create a Twitch application and set its OAuth Redirect URL to `http://localhost:3000/auth/callback`.
2. Copy `.env.example` to `.env` and set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.
3. Run `npm install`, then `npm run dev`. For a production build, use `npm run build` and `npm start`.
4. Visit `http://localhost:3000` and connect account A and account B. Each button must be authorized by the corresponding broadcaster.

Tokens are saved in local `tokens.json`, which is gitignored. Access tokens are validated and refreshed automatically; Twitch may rotate the refresh token, and the latest token pair is saved.

## OAuth scopes

The authorization request asks for:

- `channel:manage:raids` — start a raid on behalf of streamer A.
- `user:read:chat` — receive chat messages for the authorized account through EventSub.
- `user:write:chat` — send the occasional packing confirmation and manual-raid fallback as account A.

The `channel.raid` EventSub subscription does not require an authorization scope. Chat subscriptions use the user access token for the broadcaster whose chat is being read.

## OBS setup

Add Browser Sources to OBS and set each source to 1920 × 1080:

- On A's stream: `http://localhost:3000/overlay/pack`
- On B's stream: `http://localhost:3000/overlay/unbox`

The pages have transparent backgrounds and connect to the local server over WebSocket. Twitch emotes are displayed using Twitch's static emote image CDN.

Overlay clients reconnect automatically if the local WebSocket disconnects. The server logs which overlay page connects and disconnects, how many clients receive each event, and how many acknowledge rendering it.

## Chat commands

- A's broadcaster or a moderator starts a window with `!carepack <target>`. This opens a 90-second packing window and requests a Twitch raid. If Twitch rejects the raid request, the window stays open and the bot asks A to start the raid manually.
- Viewers add one item each with `!pack <message>`. Messages are limited to 100 characters. The bot only posts an occasional confirmation to avoid chat spam.

The package appears on B's unbox overlay when A raids B. Raids without a matching package show a general welcome with the raider name and viewer count.

## Local overlay debugging

- `GET http://localhost:3000/debug/demo-pack` starts a 90-second pack countdown and adds three sample items.
- `GET http://localhost:3000/debug/replay-unbox` replays the last package arrival in the current server session.

## Demo mode

Demo mode will be documented here when implemented.
