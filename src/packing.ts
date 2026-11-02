export type PackageEmote = { id: string; name: string; begin: number; end: number };
export type PackageItem = { user: string; text: string; emotes: PackageEmote[] };
export type PackageAccumulator = { users: Set<string>; items: PackageItem[] };

export function authorizedCarepackTarget(text: string, isBroadcaster: boolean, isModerator: boolean): string | undefined {
  const match = /^!carepack\s+(.+)$/i.exec(text.trim());
  return match && (isBroadcaster || isModerator) ? match[1] : undefined;
}

export function parsePackCommand(rawText: string): { text: string; textStart: number } | undefined {
  const trimmed = rawText.trim();
  const match = /^!pack\s+(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  return {
    text: match[1],
    textStart: rawText.indexOf(trimmed) + match[0].lastIndexOf(match[1]),
  };
}

type ChatMessageEvent = {
  chatter_user_id?: string;
  chatter_user_name?: string;
  message?: { fragments?: Array<{ type?: string; text?: string; emote?: { id?: string } | null }> };
};

export function createPackageItem(event: ChatMessageEvent, content: string, textStart: number): { userId: string; item: PackageItem } | undefined {
  const text = content.trim();
  const length = Array.from(text).length;
  const userId = String(event.chatter_user_id ?? '');
  if (!userId || !text || length > 100) return undefined;

  let offset = 0;
  const emotes: PackageEmote[] = [];
  for (const fragment of event.message?.fragments ?? []) {
    const fragmentText = fragment.text ?? '';
    const begin = offset - textStart;
    const end = begin + fragmentText.length;
    if (fragment.type === 'emote' && fragment.emote?.id && begin >= 0 && end <= text.length) {
      emotes.push({ id: fragment.emote.id, name: fragmentText, begin, end });
    }
    offset += fragmentText.length;
  }
  return { userId, item: { user: String(event.chatter_user_name ?? 'viewer'), text, emotes } };
}

export function addPackageItem(pack: PackageAccumulator, userId: string, item: PackageItem): boolean {
  const text = item.text.trim();
  if (!userId || !text || Array.from(text).length > 100 || pack.users.has(userId)) return false;
  pack.users.add(userId);
  pack.items.push({ ...item, text });
  return true;
}

export function raidMatchesPackage(
  pack: { sourceUserId: string; targetId?: string; targetLogin: string },
  raid: { fromBroadcasterId: string; toBroadcasterId: string; toBroadcasterLogin: string },
  accountAId?: string,
  accountBId?: string,
): boolean {
  return Boolean(accountAId && accountBId
    && pack.sourceUserId === accountAId
    && raid.fromBroadcasterId === accountAId
    && raid.toBroadcasterId === accountBId
    && (pack.targetId === raid.toBroadcasterId || pack.targetLogin === raid.toBroadcasterLogin.toLowerCase()));
}
