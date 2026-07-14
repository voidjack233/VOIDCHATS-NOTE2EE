import { fetchWithAuth } from '../Auth/authServiceApi';
import { fetchAppBootstrap } from '../bootstrap';
import type { Conversation, ConversationMember, GroupPermissions } from './chatTypes';
import { CHAT_API_PREFIX, createApiError } from './chatUtils';

let usedBootstrapConversations = false;

async function readApiResponse(response: Response) {
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
  return data;
}

export async function getConversations(): Promise<Conversation[]> {
  if (!usedBootstrapConversations) {
    const bootstrap = await fetchAppBootstrap();
    if (Array.isArray(bootstrap?.conversations)) {
      usedBootstrapConversations = true;
      return bootstrap.conversations;
    }
  }
  const data = await readApiResponse(await fetchWithAuth(CHAT_API_PREFIX));
  return data.conversations || [];
}

export async function getConversation(id: string): Promise<{
  conversation: Conversation & { members: ConversationMember[] };
}> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`));
}

export async function createConversation(
  type: 'group',
  name: string,
  members: string[],
): Promise<{ conversation: Conversation }> {
  return readApiResponse(await fetchWithAuth(CHAT_API_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ type, name, members }),
  }));
}

export async function createGroup(
  name: string,
  memberIds: string[],
): Promise<{ conversation: Conversation }> {
  return createConversation('group', name, memberIds);
}

export async function updateConversation(
  id: string,
  updates: { name?: string },
): Promise<{ conversation: Conversation }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  }));
}

export async function uploadConversationIcon(
  id: string,
  icon: string,
): Promise<{ conversation: Conversation }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${id}/icon`, {
    method: 'PUT',
    body: JSON.stringify({ icon }),
  }));
}

export async function removeConversationIcon(id: string): Promise<{ conversation: Conversation }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${id}/icon`, { method: 'DELETE' }));
}

export async function deleteConversation(id: string): Promise<void> {
  await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`, { method: 'DELETE' }));
}

const DM_MUTE_FOREVER = '2099-12-31T23:59:59Z';

export async function closeDM(conversationId: string): Promise<void> {
  await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/dm-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ hidden: true }),
  }));
}

export async function muteDM(conversationId: string, mute: boolean): Promise<void> {
  await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/dm-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ muted_until: mute ? DM_MUTE_FOREVER : null }),
  }));
}

export async function getOrCreateDM(userId: string): Promise<{
  conversation_id: string;
  conversation_public_id?: string | null;
  created: boolean;
}> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/dm/${userId}`, { method: 'POST' }));
}

export async function addMembers(
  conversationId: string,
  members: string[],
): Promise<{ added: string[] }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members`, {
    method: 'POST',
    body: JSON.stringify({ members }),
  }));
}

export async function removeMember(conversationId: string, userId: string): Promise<void> {
  await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/${userId}`, {
    method: 'DELETE',
  }));
}

export async function leaveConversation(conversationId: string): Promise<{ deleted: boolean }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/@me`, {
    method: 'DELETE',
  }));
}

export async function updateMemberRole(
  conversationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  }));
}

export async function transferConversationOwnership(
  conversationId: string,
  targetUserId: string,
): Promise<{ conversation: Conversation }> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ target_user_id: targetUserId }),
  }));
}

export async function updateConversationNickname(
  conversationId: string,
  userId: string,
  nickname: string | null,
): Promise<{ nickname: string | null }> {
  return readApiResponse(await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/members/${userId}/conversation-nickname`,
    { method: 'PATCH', body: JSON.stringify({ nickname }) },
  ));
}

export async function getConversationPermissions(conversationId: string): Promise<GroupPermissions> {
  const data = await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/permissions`));
  return data.permissions;
}

export async function updateConversationPermissions(
  conversationId: string,
  permissions: Partial<GroupPermissions>,
): Promise<GroupPermissions> {
  const data = await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  }));
  return data.permissions;
}
