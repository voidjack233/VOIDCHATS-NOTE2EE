import assert from 'node:assert/strict';
import test from 'node:test';
import { patchProfileFields, resolveDmIdentity, resolveProfileIdentity } from '../../../src/Services/Chat/profileIdentity';
import { getConversationDetails, patchConversationProfiles, storeConversationDetails } from '../../../src/Services/Chat/conversationCache';
import { buildMessageViewHeaderIdentity } from '../../../src/components/Chat/MessageView/MessageViewHeader';
import { friend, conversation, update } from './profileFixtures';

test('profile patch applies fields immediately; omitted fields survive and null clears', () => {
  assert.equal(patchProfileFields(friend, update).display_name, 'New Name');
  assert.equal(patchProfileFields(friend, update).avatar_url, '/avatars/new.svg');
  assert.equal(patchProfileFields(friend, { ...update, avatar_url: undefined }).avatar_url, friend.avatar_url);
  assert.equal(patchProfileFields(friend, { ...update, avatar_url: null }).avatar_url, null);
  assert.equal(friend.display_name, 'Old Name');
});

test('DM and beginning header prefer live profile to both stale snapshots', () => {
  const live = patchProfileFields(friend, update);
  const members = { peer: conversation.members![0] };
  const identity = resolveDmIdentity(conversation, members, [live], 'self');
  assert.equal(identity.displayName, 'New Name');
  assert.equal(identity.avatarUrl, '/avatars/new.svg');
  const header = buildMessageViewHeaderIdentity({ conversation, members, friends: [live], currentUserId: 'self' });
  assert.equal(header.label, 'New Name');
  assert.equal(header.avatar, '/avatars/new.svg');
  assert.equal(resolveProfileIdentity(live, members.peer).displayName, 'New Name');
});

test('cleared name/avatar never revive stale member or conversation fields', () => {
  const cleared = patchProfileFields(friend, { ...update, display_name: null, avatar_url: null });
  for (const members of [{}, { peer: conversation.members![0] }]) {
    const identity = resolveDmIdentity(conversation, members, [cleared]);
    assert.equal(identity.displayName, friend.username);
    assert.equal(identity.avatarUrl, null);
  }
});

test('nickname overrides global profile in member and summary-only views, including clearing', () => {
  const live = patchProfileFields(friend, update);
  assert.equal(resolveDmIdentity({ ...conversation, dm_nickname: 'Pet name' }, {}, [live]).displayName, 'Pet name');
  assert.equal(resolveProfileIdentity(live, { ...conversation.members![0], nickname: 'Pet name' }).displayName, 'Pet name');
  assert.equal(resolveDmIdentity({ ...conversation, dm_nickname: 'Stale nickname' }, {
    peer: { ...conversation.members![0], nickname: null },
  }, [live]).displayName, 'New Name');
});

test('stable peer ID wins over another profile with a snapshot username', () => {
  assert.equal(resolveDmIdentity(conversation, {}, [{ ...friend, id: 'someone-else' }]).friend, undefined);
});

test('cached member and DM profile patch survives reentry under either conversation alias', () => {
  storeConversationDetails(conversation);
  const other = storeConversationDetails({ ...conversation, id: 'other', public_id: '456', type: 'group' });
  patchConversationProfiles(update);
  for (const id of ['dm', '123', 'other', '456']) {
    assert.equal(getConversationDetails(id)?.members?.[0].avatar_url, update.avatar_url);
    assert.equal(getConversationDetails(id)?.members?.[0].display_name, update.display_name);
  }
  assert.equal(getConversationDetails('dm')?.dm_avatar_url, update.avatar_url);
  assert.equal(getConversationDetails('dm'), getConversationDetails('123'));
  assert.equal(other.members?.[0].display_name, 'Old member');
  patchConversationProfiles({ ...update, avatar_url: null });
  assert.equal(getConversationDetails('123')?.members?.[0].avatar_url, null);
});
