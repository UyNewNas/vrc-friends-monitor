import test from 'node:test';
import assert from 'node:assert/strict';
import { readIdentity, makeSnapshot, changesBetween } from '../core.js';

const OWNER = 'usr_demo_identity_owner';
const FRIEND = 'usr_demo_identity_friend';
const OTHER = 'usr_demo_identity_other';
const NON_MEMBER = 'usr_demo_identity_removed';
const user = extra => ({
  id: OWNER, displayName: '模拟账号', friends: [FRIEND, OTHER],
  onlineFriends: [FRIEND], activeFriends: [], offlineFriends: [OTHER], ...extra,
});

test('presence gaps preserve members as unknown and ignore nonmember status entries', () => {
  const identity = readIdentity(user({ onlineFriends: [NON_MEMBER] }));
  assert.deepEqual([...identity.states], [[FRIEND, 'unknown'], [OTHER, 'offline']]);
  const snapshot = makeSnapshot(identity, [
    { id: FRIEND, name: '模拟好友' }, { id: NON_MEMBER, name: '已删除好友' },
  ]);
  assert.deepEqual(snapshot, [
    { id: FRIEND, name: '模拟好友', state: 'unknown' },
    { id: OTHER, name: OTHER, state: 'offline' },
  ]);
});

test('every conflicting presence combination is unknown while duplicates stay valid', () => {
  const combinations = [
    { onlineFriends: [FRIEND], activeFriends: [FRIEND], offlineFriends: [OTHER] },
    { onlineFriends: [FRIEND], activeFriends: [], offlineFriends: [FRIEND, OTHER] },
    { onlineFriends: [], activeFriends: [FRIEND], offlineFriends: [FRIEND, OTHER] },
    { onlineFriends: [FRIEND], activeFriends: [FRIEND], offlineFriends: [FRIEND, OTHER] },
  ];
  for (const patch of combinations) {
    assert.deepEqual([...readIdentity(user(patch)).states], [[FRIEND, 'unknown'], [OTHER, 'offline']]);
  }
  const duplicates = readIdentity(user({ friends: [FRIEND, FRIEND, null, OTHER], onlineFriends: [FRIEND, null, FRIEND] }));
  assert.deepEqual([...duplicates.states], [[FRIEND, 'game'], [OTHER, 'offline']]);
});

test('a complete empty membership is valid but missing or malformed fields still fail', () => {
  const empty = { friends: [], onlineFriends: [], activeFriends: [], offlineFriends: [] };
  assert.equal(readIdentity(user(empty)).states.size, 0);
  assert.equal(readIdentity(user({ ...empty, onlineFriends: [NON_MEMBER] })).states.size, 0);
  assert.equal(readIdentity(user({ friends: [null], onlineFriends: [null], activeFriends: [null], offlineFriends: [null] })).states.size, 0);

  for (const field of Object.keys(empty)) {
    for (const invalid of [undefined, null, {}, 'not-an-array', ['malformed'], [0], [{}]]) {
      assert.throws(() => readIdentity(user({ [field]: invalid })), `${field} must contain valid IDs in an array`);
    }
    const missing = user();
    delete missing[field];
    assert.throws(() => readIdentity(missing));
  }
  for (const invalid of [null, {}, user({ id: null }), user({ id: 'malformed' }), user({ id: '__proto__' })]) {
    assert.throws(() => readIdentity(invalid));
  }
});

test('uncertain presence never creates notifications on entering or leaving unknown', () => {
  const snapshot = patch => makeSnapshot(readIdentity(user({ friends: [FRIEND], offlineFriends: [], ...patch })));
  const game = snapshot({ onlineFriends: [FRIEND] });
  const offline = snapshot({ onlineFriends: [], offlineFriends: [FRIEND] });
  const unclassified = snapshot({ onlineFriends: [] });
  const conflicting = snapshot({ onlineFriends: [FRIEND], offlineFriends: [FRIEND] });
  for (const uncertain of [unclassified, conflicting]) {
    for (const known of [game, offline]) {
      assert.deepEqual(changesBetween(known, uncertain, 1), []);
      assert.deepEqual(changesBetween(uncertain, known, 2), []);
    }
  }
  assert.equal(changesBetween(game, offline, 3)[0].online, false);
  assert.equal(changesBetween(offline, game, 4)[0].online, true);
});
