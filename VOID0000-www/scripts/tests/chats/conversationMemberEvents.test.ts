import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as cache from '../../../src/Services/Chat/conversationCache';
import * as identity from '../../../src/Services/Chat/profileIdentity';
import { conversation, update } from './profileFixtures';
import type { ConversationMember } from '../../../src/Services/Chat/chatTypes';

// Execute the actual member hook without the FriendsProvider rerender that masked
// its missing state transition. This is a hook-state test, not a replacement UI.
function mountMembers() {
  const group = { ...conversation, id: 'group-events', public_id: '789', type: 'group' as const };
  cache.storeConversationDetails(group);
  const handlers = new Map<string, (data: unknown) => void>();
  const cleanups: Array<() => void> = [];
  let state = { identifier: null as string | null, members: {} as Record<string, ConversationMember> };
  let transitions = 0;
  const source = readFileSync(new URL('../../../src/Services/hooks/Chats/useConversationMembers.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (props: unknown) => unknown> = {};
  const dependencies: Record<string, unknown> = {
    react: {
      useCallback: (fn: unknown) => fn,
      useEffect: (setup: () => () => void) => cleanups.push(setup()),
      useState: () => [state, (next: (current: typeof state) => typeof state) => {
        const updated = next(state);
        if (updated !== state) transitions++;
        state = updated;
      }],
    },
    '../../Chat/conversationCache': cache,
    '../../Chat/profileIdentity': identity,
    '../Friends/useFriends': { useFriends: () => ({ friends: [] }) },
    '../../Gateway/gateway': { gateway: {
      on: (event: string, callback: (data: unknown) => void) => handlers.set(event, callback),
      off: (event: string) => handlers.delete(event),
    } },
  };
  runInNewContext(output, { exports, require: (key: string) => {
    assert.ok(key in dependencies, `Unexpected dependency: ${key}`);
    return dependencies[key];
  } });
  const render = () => exports.useConversationMembers({ activeConversation: group, activeGroup: group, userId: 'self' }) as { members: Record<string, ConversationMember> };
  render();
  return { group, handlers, render, state: () => state, transitions: () => transitions, close: () => cleanups.forEach(cleanup => cleanup()) };
}

test('cache-backed non-friend event creates React-visible member state without a friends rerender', () => {
  const hook = mountMembers();
  try {
    assert.equal(hook.state().identifier, null);
    hook.handlers.get('PROFILE_UPDATE')!(update);
    assert.equal(hook.transitions(), 1);
    assert.equal(hook.state().identifier, '789');
    assert.equal((hook.state().members.peer as { display_name: string }).display_name, update.display_name);
    assert.equal(cache.getConversationDetails('789')?.members?.[0].avatar_url, update.avatar_url);
    assert.equal(cache.getConversationDetails(hook.group.id)?.members?.[0].display_name, update.display_name);
  } finally { hook.close(); }
});

test('non-friend profile events preserve nickname, apply explicit clearing, and ignore non-members', () => {
  const hook = mountMembers();
  try {
    hook.handlers.get('MEMBER_NICKNAME_UPDATE')!({ user_id: 'peer', nickname: 'Group nickname' });
    hook.handlers.get('PROFILE_UPDATE')!({ ...update, display_name: null, avatar_url: null });
    assert.deepEqual(JSON.parse(JSON.stringify(hook.state().members.peer)), {
      ...conversation.members![0], nickname: 'Group nickname', display_name: null, avatar_url: null, bio: update.bio,
    });
    assert.equal(cache.getConversationDetails('789')?.members?.[0].avatar_url, null);
    const before = hook.state();
    hook.handlers.get('PROFILE_UPDATE')!({ ...update, user_id: 'outsider' });
    assert.equal(hook.state(), before);
  } finally { hook.close(); }
  assert.equal(hook.handlers.size, 0);
});

test('detail hydration after a profile event still exposes the exact profile ID', () => {
  const hook = mountMembers();
  try {
    cache.storeConversationDetails({ ...hook.group, members: hook.group.members?.map(member => ({ ...member, profile_id: undefined })) });
    hook.handlers.get('PROFILE_UPDATE')!(update);
    assert.equal(hook.render().members.peer.profile_id, undefined);
    cache.storeConversationDetails({ ...hook.group, members: hook.group.members?.map(member => ({ ...member, profile_id: '732434999193640961' })) });
    const member = hook.render().members.peer;
    assert.equal(member.profile_id, '732434999193640961');
    assert.equal(member.display_name, update.display_name);
  } finally { hook.close(); }
});
