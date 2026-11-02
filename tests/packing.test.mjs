import test from 'node:test';
import assert from 'node:assert/strict';
import { addPackageItem, authorizedCarepackTarget, createPackageItem, parsePackCommand, raidMatchesPackage } from '../dist/packing.js';

test('each chatter can add only one item to a package', () => {
  const packageState = { users: new Set(), items: [] };
  const item = { user: 'Mira', text: 'Good luck!', emotes: [] };
  assert.equal(addPackageItem(packageState, 'user-1', item), true);
  assert.equal(addPackageItem(packageState, 'user-1', { ...item, text: 'Another one' }), false);
  assert.equal(packageState.items.length, 1);
  assert.deepEqual([...packageState.users], ['user-1']);
});

test('pack messages allow 100 characters and reject longer messages', () => {
  const packageState = { users: new Set(), items: [] };
  assert.equal(addPackageItem(packageState, 'one', { user: 'One', text: 'x'.repeat(100), emotes: [] }), true);
  assert.equal(addPackageItem(packageState, 'two', { user: 'Two', text: 'x'.repeat(101), emotes: [] }), false);
  assert.equal(packageState.items.length, 1);
});

test('pack command emote fragments become item offsets relative to the message', () => {
  const rawText = '!pack Hello PogChamp!';
  const command = parsePackCommand(rawText);
  assert.deepEqual(command, { text: 'Hello PogChamp!', textStart: 6 });
  const parsed = createPackageItem({
    chatter_user_id: 'user-3', chatter_user_name: 'Starry',
    message: { fragments: [
      { type: 'text', text: '!pack ' },
      { type: 'text', text: 'Hello ' },
      { type: 'emote', text: 'PogChamp', emote: { id: '88' } },
      { type: 'text', text: '!' },
    ] },
  }, command.text, command.textStart);
  assert.deepEqual(parsed?.item.emotes, [{ id: '88', name: 'PogChamp', begin: 6, end: 14 }]);
});

test('only the broadcaster or a moderator can start a carepack', () => {
  assert.equal(authorizedCarepackTarget('!carepack friend', false, false), undefined);
  assert.equal(authorizedCarepackTarget('!carepack friend', true, false), 'friend');
  assert.equal(authorizedCarepackTarget('!carepack friend', false, true), 'friend');
});

test('a package matches only its source and intended raid destination', () => {
  const pack = { sourceUserId: 'A-id', targetId: 'B-id', targetLogin: 'friend' };
  const raid = { fromBroadcasterId: 'A-id', toBroadcasterId: 'B-id', toBroadcasterLogin: 'friend' };
  assert.equal(raidMatchesPackage(pack, raid, 'A-id', 'B-id'), true);
  assert.equal(raidMatchesPackage(pack, { ...raid, fromBroadcasterId: 'other' }, 'A-id', 'B-id'), false);
  assert.equal(raidMatchesPackage(pack, { ...raid, toBroadcasterId: 'other', toBroadcasterLogin: 'other' }, 'A-id', 'B-id'), false);
});
