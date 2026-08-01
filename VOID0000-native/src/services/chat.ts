import { MESSAGE_PAGE_SIZE } from '../config';
import type {
  Attachment,
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
  ForwardedMessageMetadata,
  GroupPermissions,
  InvitePreview,
  Message,
  PickedAttachment,
} from '../types/models';
import { apiJson, apiRequest, ApiError } from './api';

const PREFIX = '/api/conversations';

export function parseAttachment(raw: string): Attachment {
  try {
    const parsed = JSON.parse(raw) as Attachment;
    if (parsed && typeof parsed.url === 'string') return parsed;
  } catch {
    // Legacy messages contain plain URLs.
  }
  return { url: raw };
}

export function serializeAttachment(attachment: Attachment) {
  const defined = Object.fromEntries(
    Object.entries(attachment).filter(([, value]) => value !== undefined),
  ) as Attachment;
  return Object.keys(defined).length === 1 ? defined.url : JSON.stringify(defined);
}

const normalizeMessage = (message: Partial<Message>): Message => ({
  ...message,
  conversation_id: String(message.conversation_id || ''),
  conversation_public_id: message.conversation_public_id || null,
  message_id: String(message.message_id || ''),
  sender_id: String(message.sender_id || ''),
  content: message.is_deleted ? '[deleted]' : String(message.content || ''),
  message_type: message.message_type || 'text',
  reply_to: message.reply_to || null,
  is_edited: Boolean(message.is_edited),
  edited_at: message.edited_at || null,
  is_deleted: Boolean(message.is_deleted),
  created_at: message.created_at || new Date().toISOString(),
});

export const chatService = {
  async conversations() {
    const data = await apiJson<{ success: true; conversations: Conversation[] }>(PREFIX);
    return data.conversations || [];
  },

  async conversation(id: string) {
    return apiJson<{
      success: true;
      conversation: Conversation & { members: ConversationMember[] };
    }>(`${PREFIX}/${encodeURIComponent(id)}`);
  },

  async messages(id: string, before?: string, limit = MESSAGE_PAGE_SIZE) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const data = await apiJson<{ success: true; messages: Message[]; has_more: boolean }>(
      `${PREFIX}/${encodeURIComponent(id)}/messages?${query.toString()}`,
      { cache: 'no-store' },
    );
    return {
      messages: (data.messages || []).map(normalizeMessage),
      hasMore: Boolean(data.has_more),
    };
  },

  async message(id: string, messageId: string) {
    const data = await apiJson<{ success: true; message: Message }>(
      `${PREFIX}/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
      { cache: 'no-store' },
    );
    return normalizeMessage(data.message);
  },

  async sendMessage(
    id: string,
    content: string,
    options: {
      clientMessageId?: string;
      replyTo?: string | null;
      attachments?: string[];
      messageType?: string;
      forwarded?: ForwardedMessageMetadata | null;
    } = {},
  ) {
    const data = await apiJson<{ success: true; message: Message }>(
      `${PREFIX}/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          content,
          message_type: options.messageType || 'text',
          client_message_id: options.clientMessageId || null,
          reply_to: options.replyTo || null,
          attachments: options.attachments || [],
          forwarded: options.forwarded || null,
          mentions: [],
          link_preview: null,
        }),
      },
    );
    return normalizeMessage(data.message);
  },

  async editMessage(id: string, message: Message, content: string) {
    await apiJson(`${PREFIX}/${encodeURIComponent(id)}/messages/${encodeURIComponent(message.message_id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        content,
        message_type: message.message_type || 'text',
        attachments: message.attachments || [],
        forwarded: message.forwarded || null,
        mentions: [],
        link_preview: null,
      }),
    });
  },

  deleteMessage(id: string, messageId: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  },

  markRead(id: string, messageId: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/messages/read`, {
      method: 'PUT',
      body: JSON.stringify({ message_id: messageId }),
    });
  },

  toggleReaction(id: string, messageId: string, emoji: string) {
    return apiJson<{ success: true; action: 'add' | 'remove'; emoji: string; user_id: string }>(
      `${PREFIX}/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
    );
  },

  typing(id: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/messages/typing`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async uploadAttachments(id: string, picked: PickedAttachment[]) {
    const uploaded: string[] = [];
    for (const item of picked) {
      const localResponse = await fetch(item.uri);
      const blob = await localResponse.blob();
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'X-Attachment-Mime': item.mime || 'application/octet-stream',
        'X-Attachment-Filename': encodeURIComponent(item.name).slice(0, 2048),
      });
      if (item.width) headers.set('X-Attachment-Width', String(item.width));
      if (item.height) headers.set('X-Attachment-Height', String(item.height));
      const response = await apiRequest(`${PREFIX}/${encodeURIComponent(id)}/attachments`, {
        method: 'POST',
        headers,
        body: blob,
      });
      const data = await response.json() as {
        success?: boolean;
        urls?: string[];
        attachments?: Array<Partial<Attachment>>;
        error?: string;
      };
      if (!response.ok || !data.success || !data.urls?.[0]) {
        throw new ApiError(data.error || 'Attachment upload failed', { status: response.status });
      }
      uploaded.push(serializeAttachment({
        url: data.urls[0],
        name: item.name,
        mime: item.mime,
        size: data.attachments?.[0]?.size ?? item.size,
        width: data.attachments?.[0]?.width ?? item.width,
        height: data.attachments?.[0]?.height ?? item.height,
        spoiler: item.spoiler,
      }));
    }
    return uploaded;
  },

  createGroup(name: string, members: string[]) {
    return apiJson<{ success: true; conversation: Conversation }>(PREFIX, {
      method: 'POST',
      body: JSON.stringify({ type: 'group', name, members }),
    });
  },

  getOrCreateDM(userId: string) {
    return apiJson<{
      success: true;
      conversation_id: string;
      conversation_public_id?: string | null;
      created: boolean;
    }>(`${PREFIX}/dm/${encodeURIComponent(userId)}`, { method: 'POST' });
  },

  updateConversation(id: string, updates: { name?: string }) {
    return apiJson<{ success: true; conversation: Conversation }>(`${PREFIX}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  uploadConversationIcon(id: string, icon: string) {
    return apiJson<{ success: true; conversation: Conversation }>(`${PREFIX}/${encodeURIComponent(id)}/icon`, {
      method: 'PUT',
      body: JSON.stringify({ icon }),
    });
  },

  removeConversationIcon(id: string) {
    return apiJson<{ success: true; conversation: Conversation }>(`${PREFIX}/${encodeURIComponent(id)}/icon`, {
      method: 'DELETE',
    });
  },

  deleteConversation(id: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  closeDM(id: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/dm-settings`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: true }),
    });
  },

  muteDM(id: string, mute: boolean) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/dm-settings`, {
      method: 'PATCH',
      body: JSON.stringify({ muted_until: mute ? '2099-12-31T23:59:59Z' : null }),
    });
  },

  addMembers(id: string, members: string[]) {
    return apiJson<{ success: true; added: string[] }>(`${PREFIX}/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify({ members }),
    });
  },

  removeMember(id: string, userId: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  },

  leaveGroup(id: string) {
    return apiJson<{ success: true; deleted: boolean }>(`${PREFIX}/${encodeURIComponent(id)}/members/@me`, {
      method: 'DELETE',
    });
  },

  updateMemberRole(id: string, userId: string, role: string) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  },

  transferOwnership(id: string, userId: string) {
    return apiJson<{ success: true; conversation: Conversation }>(
      `${PREFIX}/${encodeURIComponent(id)}/members/transfer-ownership`,
      { method: 'POST', body: JSON.stringify({ target_user_id: userId }) },
    );
  },

  updateNickname(id: string, userId: string, nickname: string | null) {
    return apiJson<{ success: true; nickname: string | null }>(
      `${PREFIX}/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/conversation-nickname`,
      { method: 'PATCH', body: JSON.stringify({ nickname }) },
    );
  },

  async permissions(id: string) {
    const data = await apiJson<{ success: true; permissions: GroupPermissions }>(
      `${PREFIX}/${encodeURIComponent(id)}/permissions`,
    );
    return data.permissions;
  },

  async updatePermissions(id: string, permissions: Partial<GroupPermissions>) {
    const data = await apiJson<{ success: true; permissions: GroupPermissions }>(
      `${PREFIX}/${encodeURIComponent(id)}/permissions`,
      { method: 'PUT', body: JSON.stringify({ permissions }) },
    );
    return data.permissions;
  },

  async invites(id: string) {
    const data = await apiJson<{
      success: true;
      invites: ConversationInviteLink[];
      pending_requests: ConversationJoinRequest[];
    }>(`${PREFIX}/${encodeURIComponent(id)}/invites`);
    return { invites: data.invites || [], requests: data.pending_requests || [] };
  },

  async createInvite(id: string, expiresInDays = 7, maxUses: number | null = null) {
    const data = await apiJson<{ success: true; invite: ConversationInviteLink }>(
      `${PREFIX}/${encodeURIComponent(id)}/invites`,
      { method: 'POST', body: JSON.stringify({ expires_in_days: expiresInDays, max_uses: maxUses }) },
    );
    return data.invite;
  },

  revokeInvite(id: string, inviteId: number) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/invites/${inviteId}/revoke`, { method: 'POST' });
  },

  approveJoinRequest(id: string, requestId: number) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/invites/requests/${requestId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  declineJoinRequest(id: string, requestId: number) {
    return apiJson(`${PREFIX}/${encodeURIComponent(id)}/invites/requests/${requestId}/decline`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async invitePreview(code: string) {
    const data = await apiJson<{ success: true; invite: InvitePreview }>(
      `${PREFIX}/invite-links/${encodeURIComponent(code)}`,
    );
    return data.invite;
  },

  inviteStatus(code: string) {
    return apiJson<{
      success: true;
      status: 'none' | 'pending' | 'declined' | 'approved' | 'member';
      conversation_public_id?: string | null;
    }>(`${PREFIX}/invite-links/${encodeURIComponent(code)}/status`);
  },

  requestJoin(code: string) {
    return apiJson<{ success: true; status: 'pending'; request_id: number }>(
      `${PREFIX}/invite-links/${encodeURIComponent(code)}/request`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  },
};
