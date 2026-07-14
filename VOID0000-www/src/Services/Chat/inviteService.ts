import { fetchWithAuth } from '../Auth/authServiceApi';
import type {
  ConversationInviteLink,
  ConversationJoinRequest,
  InvitePreview,
} from './chatTypes';
import { CHAT_API_PREFIX, createApiError } from './chatUtils';

async function readApiResponse(response: Response) {
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
  return data;
}

export async function approveConversationJoinRequest(
  conversationId: string,
  requestId: number,
): Promise<{ approved_user_id: string }> {
  return readApiResponse(await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/invites/requests/${requestId}/approve`,
    { method: 'POST', body: JSON.stringify({}) },
  ));
}

export async function declineConversationJoinRequest(
  conversationId: string,
  requestId: number,
): Promise<void> {
  await readApiResponse(await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/invites/requests/${requestId}/decline`,
    { method: 'POST', body: JSON.stringify({}) },
  ));
}

export async function getConversationInvites(conversationId: string): Promise<{
  invites: ConversationInviteLink[];
  pending_requests: ConversationJoinRequest[];
}> {
  const data = await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites`));
  return { invites: data.invites || [], pending_requests: data.pending_requests || [] };
}

export async function createConversationInviteLink(
  conversationId: string,
  options?: { expires_in_days?: number; max_uses?: number | null },
): Promise<ConversationInviteLink> {
  const data = await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites`, {
    method: 'POST',
    body: JSON.stringify({
      expires_in_days: options?.expires_in_days ?? 7,
      max_uses: options?.max_uses ?? null,
    }),
  }));
  return data.invite;
}

export async function revokeConversationInviteLink(
  conversationId: string,
  inviteId: number,
): Promise<void> {
  await readApiResponse(await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/invites/${inviteId}/revoke`,
    { method: 'POST' },
  ));
}

export async function getInvitePreview(code: string): Promise<InvitePreview> {
  const data = await readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}`));
  return data.invite;
}

export async function getInviteRequestStatus(code: string): Promise<{
  status: 'none' | 'pending' | 'declined' | 'approved' | 'member';
  conversation_public_id?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
}> {
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}/status`));
}

export async function requestJoinByInviteCode(
  code: string,
  _currentUserId?: string,
): Promise<{ status: 'pending'; request_id: number; created_at: string }> {
  void _currentUserId;
  return readApiResponse(await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  }));
}
