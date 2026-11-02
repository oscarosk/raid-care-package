import 'dotenv/config';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const TOKEN_FILE = path.resolve('tokens.json');
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const SCOPES = ['channel:manage:raids', 'user:read:chat', 'user:write:chat'];
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env');

type Account = 'A' | 'B';
type TwitchToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string[];
  user_id: string;
  login: string;
  display_name: string;
};
type TokenStore = Partial<Record<Account, TwitchToken>>;
type PackageEmote = { id: string; name: string; begin: number; end: number };
type PackageItem = { user: string; text: string; emotes: PackageEmote[] };
type CarePackage = {
  id: string;
  sourceUserId: string;
  targetLogin: string;
  targetId?: string;
  targetName: string;
  startedAt: number;
  endsAt: number;
  accepting: boolean;
  items: PackageItem[];
  users: Set<string>;
  cleanupTimer?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout;
};
type SubscriptionSpec = {
  key: string;
  type: 'channel.chat.message' | 'channel.raid';
  version: '1';
  condition: Record<string, string>;
};
type EventSubState = {
  socket?: WebSocket;
  sessionId?: string;
  reconnectAttempt: number;
  heartbeat?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  subscriptionRetries: Map<string, { timer?: NodeJS.Timeout; spec: SubscriptionSpec; attempt: number }>;
};
const tokens: TokenStore = {};
const pendingStates = new Map<string, { account: Account; createdAt: number }>();
const eventSubStates = new Map<Account, EventSubState>();
const carePackages = new Map<string, CarePackage>();
const seenEventIds = new Set<string>();
const overlayClients = new Map<WebSocket, 'pack' | 'unbox'>();
let overlayServer: WebSocketServer | undefined;
let latestUnboxMessage: Record<string, unknown> | undefined;
let latestUnboxAt = 0;
let activePacking: CarePackage | undefined;
let chatSendQueue: Promise<void> = Promise.resolve();
let lastChatSentAt = 0;
let itemsSinceConfirmation = 0;
let stopping = false;

async function saveTokens(): Promise<void> {
  await writeFile(TOKEN_FILE, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
}

async function loadTokens(): Promise<void> {
  try {
    Object.assign(tokens, JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as TokenStore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function twitchTokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Twitch token request failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

async function identifyAndStore(account: Account, tokenData: Record<string, unknown>): Promise<void> {
  const accessToken = String(tokenData.access_token);
  const validate = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!validate.ok) throw new Error(`Twitch token validation failed (${validate.status})`);
  const identity = await validate.json() as { user_id: string; login: string; scopes: string[] };
  const missingScopes = SCOPES.filter(scope => !identity.scopes.includes(scope));
  if (missingScopes.length) throw new Error(`Twitch did not grant required scopes: ${missingScopes.join(', ')}`);
  const profileResponse = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(identity.user_id)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId! },
  });
  if (!profileResponse.ok) throw new Error(`Could not load Twitch profile (${profileResponse.status})`);
  const profile = await profileResponse.json() as { data: Array<{ display_name: string }> };
  tokens[account] = {
    access_token: accessToken,
    refresh_token: String(tokenData.refresh_token),
    expires_at: Date.now() + Number(tokenData.expires_in) * 1000,
    scope: identity.scopes,
    user_id: identity.user_id,
    login: identity.login,
    display_name: profile.data[0]?.display_name ?? identity.login,
  };
  await saveTokens();
}

async function ensureFreshToken(account: Account): Promise<TwitchToken | undefined> {
  const token = tokens[account];
  if (!token) return undefined;
  // Validate locally stored access tokens on startup. A transient validation
  // outage should not discard an otherwise unexpired token.
  try {
    const validation = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token.access_token}` },
    });
    if (validation.ok) return token;
    if (validation.status !== 401 && token.expires_at > Date.now() + 60_000) {
      console.warn(`[auth:${account}] Token validation returned ${validation.status}; keeping the unexpired token for now.`);
      return token;
    }
  } catch (error) {
    if (token.expires_at > Date.now() + 60_000) {
      console.warn(`[auth:${account}] Token validation was unavailable; keeping the unexpired token for now.`, error);
      return token;
    }
  }
  try {
    const refreshed = await twitchTokenRequest(new URLSearchParams({
      client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: token.refresh_token,
    }));
    await identifyAndStore(account, refreshed);
    return tokens[account];
  } catch (error) {
    console.error(`[auth:${account}] Token refresh failed; reconnect this account:`, error);
    delete tokens[account];
    await saveTokens();
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const app = express();
app.use('/overlay', express.static(path.resolve('public/overlay'), { extensions: ['html'] }));
app.get('/', (_request, response) => {
  const accountStatus = (['A', 'B'] as const).map(account => {
    const token = tokens[account];
    const label = token ? `Connected as ${escapeHtml(token.display_name)}` : 'Not connected';
    return `<li><strong>Account ${account}:</strong> ${label} — <a href="/auth/start/${account}">Connect account ${account}</a></li>`;
  }).join('');
  response.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Raid Care Package</title><style>body{font:16px system-ui;max-width:720px;margin:12vh auto;padding:0 24px;background:#111827;color:#f8fafc}a{color:#a5b4fc}li{margin:1rem 0}</style></head><body><h1>Raid Care Package</h1><p>Connect the two broadcaster accounts to start EventSub logging.</p><ul>${accountStatus}</ul><p>OAuth redirect: <code>${REDIRECT_URI}</code></p></body></html>`);
});

app.get('/auth/start/:account', (request, response) => {
  const account = request.params.account.toUpperCase();
  if (account !== 'A' && account !== 'B') return response.status(404).send('Account must be A or B.');
  const state = randomBytes(32).toString('hex');
  pendingStates.set(state, { account, createdAt: Date.now() });
  const authorizeUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId!, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '), state,
    force_verify: 'true',
  }).toString();
  response.redirect(authorizeUrl.toString());
});

app.get('/auth/callback', async (request, response) => {
  const state = String(request.query.state ?? '');
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) return response.status(400).send('OAuth state is invalid or expired. Start the connection again.');
  if (typeof request.query.error === 'string') return response.status(400).send(`Twitch authorization failed: ${escapeHtml(request.query.error_description?.toString() ?? request.query.error)}`);
  if (typeof request.query.code !== 'string') return response.status(400).send('Twitch did not return an authorization code.');
  try {
    const tokenData = await twitchTokenRequest(new URLSearchParams({
      client_id: clientId!, client_secret: clientSecret!, code: request.query.code,
      grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
    }));
    await identifyAndStore(pending.account, tokenData);
    response.redirect('/');
    void startEventSub();
  } catch (error) {
    console.error(`[auth:${pending.account}] Authorization failed:`, error);
    response.status(502).send('Twitch authorization could not be completed. Check the server log and try again.');
  }
});

function sendOverlay(view: 'pack' | 'unbox', message: Record<string, unknown>): void {
  const encoded = JSON.stringify(message);
  for (const [socket, socketView] of overlayClients) {
    if (socketView === view && socket.readyState === WebSocket.OPEN) socket.send(encoded);
  }
}

function sendAChatMessage(message: string): Promise<void> {
  chatSendQueue = chatSendQueue.then(async () => {
    const waitMs = Math.max(0, 1200 - (Date.now() - lastChatSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    const token = await ensureFreshToken('A');
    if (!token) throw new Error('Account A has no valid chat token');
    const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': clientId!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_id: token.user_id, sender_id: token.user_id, message }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Chat send failed (${response.status}): ${body}`);
    lastChatSentAt = Date.now();
  }).catch(error => {
    console.error('[A] Could not send a chat message:', error);
  });
  return chatSendQueue;
}

async function resolveTwitchTarget(login: string): Promise<{ id: string; login: string; display_name: string }> {
  const token = await ensureFreshToken('A');
  if (!token) throw new Error('Account A has no valid token');
  const url = new URL('https://api.twitch.tv/helix/users');
  url.searchParams.set('login', login);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': clientId! } });
  const data = await response.json() as { data?: Array<{ id: string; login: string; display_name: string }>; message?: string };
  if (!response.ok || !data.data?.[0]) throw new Error(data.message ?? `Twitch user "${login}" was not found`);
  return data.data[0];
}

async function requestRaid(pack: CarePackage): Promise<void> {
  try {
    const token = await ensureFreshToken('A');
    if (!token) throw new Error('Account A has no valid raid token');
    const target = await resolveTwitchTarget(pack.targetLogin);
    if (carePackages.get(pack.targetLogin) === pack) carePackages.delete(pack.targetLogin);
    pack.targetLogin = target.login.toLowerCase();
    pack.targetId = target.id;
    pack.targetName = target.display_name;
    carePackages.set(pack.targetLogin, pack);
    sendOverlay('pack', { kind: 'pack_target_resolved', target: pack.targetName });
    const url = new URL('https://api.twitch.tv/helix/raids');
    url.searchParams.set('from_broadcaster_id', token.user_id);
    url.searchParams.set('to_broadcaster_id', target.id);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': clientId! },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Start a raid failed (${response.status}): ${body}`);
    console.log(`[A] Raid countdown requested for ${target.display_name}`);
  } catch (error) {
    console.error(`[A] Raid API failed for ${pack.targetLogin}; packing window remains open:`, error);
    await sendAChatMessage(`Raid Care Package is open for ${pack.targetName}. Please start the raid manually.`);
  }
}

function openCarePackage(targetText: string): void {
  const targetLogin = targetText.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(targetLogin)) return;
  if (activePacking?.accepting) {
    activePacking.accepting = false;
    if (activePacking.endTimer) clearTimeout(activePacking.endTimer);
    sendOverlay('pack', { kind: 'pack_ended', target: activePacking.targetName });
  }
  const now = Date.now();
  const pack: CarePackage = {
    id: randomBytes(12).toString('hex'),
    sourceUserId: tokens.A?.user_id ?? '',
    targetLogin,
    targetName: targetLogin,
    startedAt: now,
    endsAt: now + 90_000,
    accepting: true,
    items: [],
    users: new Set(),
  };
  activePacking = pack;
  carePackages.set(targetLogin, pack);
  itemsSinceConfirmation = 0;
  sendOverlay('pack', { kind: 'pack_started', target: pack.targetName, endsAt: pack.endsAt, durationMs: 90_000 });
  pack.endTimer = setTimeout(() => {
    pack.accepting = false;
    if (activePacking === pack) activePacking = undefined;
    sendOverlay('pack', { kind: 'pack_ended', target: pack.targetName });
  }, 90_000);
  pack.endTimer.unref();
  pack.cleanupTimer = setTimeout(() => {
    if (carePackages.get(pack.targetLogin) === pack) carePackages.delete(pack.targetLogin);
  }, 10 * 60_000);
  pack.cleanupTimer.unref();
  void requestRaid(pack);
}

function collectPackItem(event: Record<string, any>, text: string, textStart: number): void {
  const pack = activePacking;
  if (!pack?.accepting || Date.now() >= pack.endsAt) return;
  const userId = String(event.chatter_user_id ?? '');
  const user = String(event.chatter_user_name ?? 'viewer');
  const message = event.message as { text?: string; fragments?: Array<{ type?: string; text?: string; emote?: { id?: string } | null }> } | undefined;
  text = text.trim();
  const length = Array.from(text).length;
  if (!userId || !text || length > 100 || pack.users.has(userId)) return;

  let offset = 0;
  const emotes: PackageEmote[] = [];
  for (const fragment of message?.fragments ?? []) {
    const fragmentText = fragment.text ?? '';
    const startInText = offset - textStart;
    const endInText = startInText + fragmentText.length;
    if (fragment.type === 'emote' && fragment.emote?.id && startInText >= 0 && endInText <= text.length) {
      emotes.push({ id: fragment.emote.id, name: fragmentText, begin: startInText, end: endInText });
    }
    offset += fragmentText.length;
  }
  const item: PackageItem = { user, text, emotes };
  pack.users.add(userId);
  pack.items.push(item);
  sendOverlay('pack', { kind: 'pack_item', item, itemCount: pack.items.length });
  itemsSinceConfirmation++;
  if (itemsSinceConfirmation === 20) {
    itemsSinceConfirmation = 0;
    void sendAChatMessage('The care package is filling up! Add yours with !pack <message>.');
  }
}

async function handleChatNotification(account: Account, event: Record<string, any>): Promise<void> {
  if (account !== 'A') return;
  const rawText = String(event.message?.text ?? '');
  const text = rawText.trim();
  const carepack = /^!carepack\s+(.+)$/i.exec(text);
  if (carepack) {
    const isBroadcaster = Boolean(event.chatter_is_broadcaster)
      || event.badges?.some((badge: { set_id?: string }) => badge.set_id === 'broadcaster');
    const isModerator = Boolean(event.chatter_is_moderator)
      || event.badges?.some((badge: { set_id?: string }) => badge.set_id === 'moderator');
    if (isBroadcaster || isModerator) openCarePackage(carepack[1]);
    return;
  }
  const packItem = /^!pack\s+(.+)$/i.exec(text);
  if (packItem) {
    const contentStart = rawText.indexOf(text) + packItem.index + packItem[0].lastIndexOf(packItem[1]);
    collectPackItem(event, packItem[1], contentStart);
  }
}

function handleRaidNotification(event: Record<string, any>): void {
  const raiderId = String(event.from_broadcaster_user_id ?? '');
  const raider = String(event.from_broadcaster_user_name ?? event.from_broadcaster_user_login ?? 'A streamer');
  const destinationId = String(event.to_broadcaster_user_id ?? '');
  const destinationLogin = String(event.to_broadcaster_user_login ?? '').toLowerCase();
  const viewers = Number(event.viewers ?? 0);
  const accountA = tokens.A;
  const accountB = tokens.B;
  const pack = Array.from(carePackages.values()).find(candidate =>
    Boolean(accountA && candidate.sourceUserId === accountA.user_id && raiderId === accountA.user_id)
    && Boolean(accountB && destinationId === accountB.user_id)
    && (candidate.targetId === destinationId || candidate.targetLogin === destinationLogin),
  );

  if (pack) {
    pack.accepting = false;
    if (pack.endTimer) clearTimeout(pack.endTimer);
    if (pack.cleanupTimer) clearTimeout(pack.cleanupTimer);
    for (const [key, stored] of carePackages) if (stored === pack) carePackages.delete(key);
    if (activePacking === pack) activePacking = undefined;
    sendOverlay('pack', { kind: 'pack_ended', target: pack.targetName });
    latestUnboxMessage = {
      kind: 'raid_arrival',
      packageFound: true,
      raider,
      viewers,
      target: accountB?.display_name ?? pack.targetName,
      items: pack.items,
    };
  } else {
    latestUnboxMessage = { kind: 'raid_arrival', packageFound: false, raider, viewers, items: [] };
  }
  latestUnboxAt = Date.now();
  sendOverlay('unbox', latestUnboxMessage);
  console.log(`[B] Raid arrived from ${raider} (${viewers} viewers), package ${pack ? 'found' : 'not found'}`);
}

function subscriptionSpecs(account: Account, token: TwitchToken): SubscriptionSpec[] {
  const specs: SubscriptionSpec[] = [{
    key: 'channel.chat.message', type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: token.user_id, user_id: token.user_id },
  }];
  if (account === 'B') specs.push({
    key: 'channel.raid', type: 'channel.raid', version: '1',
    condition: { to_broadcaster_user_id: token.user_id },
  });
  return specs;
}

function clearSubscriptionRetries(state: EventSubState, forget = true): void {
  for (const retry of state.subscriptionRetries.values()) {
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = undefined;
  }
  if (forget) state.subscriptionRetries.clear();
}

function queueSubscriptionRetry(
  account: Account,
  state: EventSubState,
  sessionId: string,
  spec: SubscriptionSpec,
  attempt: number,
  error: unknown,
): void {
  const existing = state.subscriptionRetries.get(spec.key);
  if (existing?.timer) clearTimeout(existing.timer);
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  console.error(`[${account}] EventSub ${spec.type} subscription failed; retrying in ${delay / 1000}s:`, error);
  const timer = setTimeout(() => {
    const retry = state.subscriptionRetries.get(spec.key);
    if (retry) retry.timer = undefined;
    if (state.socket?.readyState === WebSocket.OPEN && state.sessionId === sessionId && !stopping) {
      state.subscriptionRetries.delete(spec.key);
      void createAccountSubscription(account, state, sessionId, spec, attempt + 1);
    }
  }, delay);
  timer.unref();
  state.subscriptionRetries.set(spec.key, { timer, spec, attempt });
}

async function createAccountSubscription(
  account: Account,
  state: EventSubState,
  sessionId: string,
  spec: SubscriptionSpec,
  attempt = 0,
  tokenOverride?: TwitchToken,
): Promise<void> {
  if (state.socket?.readyState !== WebSocket.OPEN || state.sessionId !== sessionId) return;
  try {
    const token = tokenOverride ?? await ensureFreshToken(account);
    if (!token) throw new Error(`Account ${account} has no valid token`);
    if (state.socket?.readyState !== WebSocket.OPEN || state.sessionId !== sessionId) return;
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': clientId!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: spec.type, version: spec.version, condition: spec.condition,
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    const responseText = await response.text();
    let data: { data?: Array<{ status: string }>; message?: string } = {};
    try { data = JSON.parse(responseText) as typeof data; } catch { /* keep raw response text for the error below */ }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.message ?? responseText}`);
    const retry = state.subscriptionRetries.get(spec.key);
    if (retry?.timer) clearTimeout(retry.timer);
    state.subscriptionRetries.delete(spec.key);
    console.log(`[${account}] EventSub subscribed ${spec.type} (${data.data?.[0]?.status ?? 'created'})`);
  } catch (error) {
    if (state.socket?.readyState === WebSocket.OPEN && state.sessionId === sessionId) {
      queueSubscriptionRetry(account, state, sessionId, spec, attempt, error);
    }
  }
}

function connectAccountEventSub(
  account: Account,
  url = EVENTSUB_URL,
  previousSocket?: WebSocket,
  state: EventSubState = eventSubStates.get(account) ?? { reconnectAttempt: 0, subscriptionRetries: new Map() },
): void {
  if (stopping) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const socket = new WebSocket(url);
  state.socket = socket;
  if (!previousSocket) {
    state.sessionId = undefined;
    clearSubscriptionRetries(state);
  }
  eventSubStates.set(account, state);

  let keepaliveTimeoutSeconds = 10;
  const armHeartbeat = (seconds: number): void => {
    if (state.socket !== socket) return;
    if (state.heartbeat) clearTimeout(state.heartbeat);
    state.heartbeat = setTimeout(() => {
      if (state.socket !== socket) return;
      console.warn(`[${account}] EventSub keepalive timeout after ${seconds}s; terminating socket`);
      socket.terminate();
    }, (seconds + 2) * 1000);
  };
  socket.on('open', () => console.log(`[${account}] EventSub WebSocket connected`));
  socket.on('message', (raw: WebSocket.RawData) => {
    let messageType = 'unparsed';
    try {
      // Twitch's timeout is a maximum period of silence. Notifications also
      // prove the connection is alive, so reset the watchdog for every frame.
      armHeartbeat(keepaliveTimeoutSeconds);
      const message = JSON.parse(raw.toString()) as {
        metadata?: { message_type?: string; message_id?: string };
        payload?: {
          session?: { id?: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
          subscription?: { type?: string; status?: string; condition?: Record<string, string> };
          event?: Record<string, unknown>;
        };
      };
      const type = message.metadata?.message_type;
      messageType = type ?? 'unknown';
      if (type === 'session_welcome') {
        const sessionId = message.payload?.session?.id;
        if (!sessionId) throw new Error('Welcome message did not include a session ID');
        keepaliveTimeoutSeconds = Number(message.payload?.session?.keepalive_timeout_seconds ?? 10);
        state.sessionId = sessionId;
        state.reconnectAttempt = 0;
        armHeartbeat(keepaliveTimeoutSeconds);
        console.log(`[${account}] EventSub session ready: ${sessionId}`);
        previousSocket?.close();
        // Twitch migrates the existing subscriptions when a reconnect URL is used.
        if (previousSocket) {
          const pendingRetries = Array.from(state.subscriptionRetries.values(), retry => ({ spec: retry.spec, attempt: retry.attempt }));
          clearSubscriptionRetries(state);
          for (const retry of pendingRetries) {
            queueSubscriptionRetry(account, state, sessionId, retry.spec, retry.attempt, 'resuming retry on the reconnected session');
          }
        } else {
          void ensureFreshToken(account).then(token => {
            if (!token) throw new Error(`Account ${account} has no valid token`);
            for (const spec of subscriptionSpecs(account, token)) {
              void createAccountSubscription(account, state, sessionId, spec, 0, token);
            }
          }).catch(error => console.error(`[${account}] Could not prepare EventSub subscriptions:`, error));
        }
      } else if (type === 'session_keepalive') {
        // The watchdog was reset above for this keepalive frame.
      } else if (type === 'session_reconnect') {
        const reconnectUrl = message.payload?.session?.reconnect_url;
        if (reconnectUrl) connectAccountEventSub(account, reconnectUrl, socket, state);
      } else if (type === 'notification') {
        const eventId = message.metadata?.message_id;
        if (eventId && seenEventIds.has(eventId)) return;
        if (eventId) {
          seenEventIds.add(eventId);
          if (seenEventIds.size > 1000) seenEventIds.delete(seenEventIds.values().next().value!);
        }
        const subscriptionType = message.payload?.subscription?.type ?? 'event';
        const event = message.payload?.event ?? {};
        console.log(`[${account}] ${subscriptionType}: ${JSON.stringify(event)}`);
        if (subscriptionType === 'channel.chat.message') {
          void handleChatNotification(account, event).catch(error => {
            console.error(`[${account}] Error handling channel.chat.message event:`, error);
          });
        } else if (account === 'B' && subscriptionType === 'channel.raid') {
          try {
            handleRaidNotification(event);
          } catch (error) {
            console.error('[B] Error handling channel.raid event:', error);
          }
        }
      } else if (type === 'revocation') {
        const subscription = message.payload?.subscription;
        console.warn(`[${account}] EventSub subscription revoked (${subscription?.type ?? 'unknown'}, ${subscription?.status ?? 'unknown'})`);
        if (subscription?.type && tokens[account]) {
          const spec = subscriptionSpecs(account, tokens[account]!).find(candidate => candidate.type === subscription.type);
          if (spec && state.sessionId) {
            queueSubscriptionRetry(account, state, state.sessionId, spec, 0, `subscription revoked: ${subscription.status ?? 'unknown'}`);
          }
        }
      }
    } catch (error) {
      console.error(`[${account}] Error handling EventSub ${messageType} message:`, error);
    }
  });
  socket.on('error', error => console.error(`[${account}] EventSub WebSocket error:`, error.message));
  socket.on('close', (code, reason) => {
    console.warn(`[${account}] EventSub WebSocket closed (code ${code}, reason: ${reason.toString('utf8') || '(empty)'})`);
    if (state.socket !== socket) return;
    if (state.heartbeat) clearTimeout(state.heartbeat);
    state.socket = undefined;
    state.sessionId = undefined;
    clearSubscriptionRetries(state);
    if (!stopping) {
      const delay = Math.min(30_000, 1000 * 2 ** state.reconnectAttempt++);
      console.warn(`[${account}] EventSub disconnected; reconnecting in ${delay / 1000}s`);
      state.reconnectTimer = setTimeout(() => connectAccountEventSub(account, EVENTSUB_URL, undefined, state), delay);
      state.reconnectTimer.unref();
    }
  });
}

async function startEventSub(): Promise<void> {
  for (const account of ['A', 'B'] as const) {
    if (!tokens[account]) continue;
    const state = eventSubStates.get(account);
    if (state?.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) continue;
    const token = await ensureFreshToken(account);
    if (token) connectAccountEventSub(account);
  }
}

const httpServer = createServer(app);
overlayServer = new WebSocketServer({ server: httpServer, path: '/ws' });
overlayServer.on('connection', (socket, request) => {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const view = requestUrl.searchParams.get('view');
  if (view !== 'pack' && view !== 'unbox') {
    socket.close(1008, 'Unknown overlay view');
    return;
  }
  overlayClients.set(socket, view);
  socket.on('close', () => overlayClients.delete(socket));
  socket.on('error', error => console.error(`[overlay:${view}] WebSocket error:`, error.message));
  if (view === 'pack' && activePacking?.accepting) {
    socket.send(JSON.stringify({ kind: 'pack_started', target: activePacking.targetName, endsAt: activePacking.endsAt, durationMs: 90_000 }));
    activePacking.items.forEach((item, index) => socket.send(JSON.stringify({ kind: 'pack_item', item, itemCount: index + 1 })));
  } else if (view === 'unbox' && latestUnboxMessage && Date.now() - latestUnboxAt < 3 * 60_000) {
    socket.send(JSON.stringify(latestUnboxMessage));
  }
});
overlayServer.on('error', error => console.error('[overlay] WebSocket server error:', error.message));

async function main(): Promise<void> {
  await loadTokens();
  for (const account of ['A', 'B'] as const) await ensureFreshToken(account);
  httpServer.listen(PORT, () => console.log(`Raid Care Package listening at http://localhost:${PORT}`));
  if (tokens.A || tokens.B) await startEventSub();
}

function stopEventSub(): void {
  stopping = true;
  for (const state of eventSubStates.values()) {
    if (state.heartbeat) clearTimeout(state.heartbeat);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    clearSubscriptionRetries(state);
    state.socket?.close();
  }
}

process.on('SIGINT', () => { stopEventSub(); process.exit(0); });
process.on('SIGTERM', () => { stopEventSub(); process.exit(0); });
void main().catch(error => { console.error(error); process.exit(1); });
