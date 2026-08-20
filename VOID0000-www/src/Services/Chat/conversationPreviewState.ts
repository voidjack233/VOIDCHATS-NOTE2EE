import type { Conversation } from './chatTypes';

type ConversationPreviewSource = 'live' | 'mutation' | 'server' | 'view' | 'store';

interface PreviewSource {
  message_id: string;
  sender_id: string;
  content?: string | null;
  attachments?: string[];
  is_deleted: boolean;
  message_type: string;
  created_at: string;
  edited_at?: string | null;
}

interface ConversationPreviewCandidate {
  messageId: string | null;
  createdAt: string | null;
  revisionAt: string | null;
  preview: string | null;
  source: ConversationPreviewSource;
  viewerId: string | null;
}

interface ConversationPreviewEntry extends ConversationPreviewCandidate {
  observedOrder: number;
}

type ServerPreviewConversation = Pick<
  Conversation,
  'last_message_id' | 'last_message_sender_id' | 'last_message_preview' | 'updated_at'
>;

const MAX_PREVIEW_LENGTH = 120;
const SOURCE_PRIORITY: Record<ConversationPreviewSource, number> = {
  store: 1,
  view: 2,
  server: 3,
  mutation: 4,
  live: 5,
};

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

const normalizeTimestamp = (value?: string | null) => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const compareTimestamp = (left?: string | null, right?: string | null) => {
  const leftValue = left ? new Date(left).getTime() : 0;
  const rightValue = right ? new Date(right).getTime() : 0;
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? 1 : -1;
};

function truncatePreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_PREVIEW_LENGTH
    ? compact
    : `${compact.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}...`;
}

export function formatConversationPreview(
  message: Pick<PreviewSource, 'sender_id' | 'content' | 'attachments' | 'is_deleted' | 'message_type'> | null | undefined,
  currentUserId?: string | null,
): string | null {
  if (!message) return null;
  if (message.is_deleted) return 'Message deleted';

  const attachmentCount = message.attachments?.length || 0;
  const isSender = Boolean(currentUserId && message.sender_id === currentUserId);
  if (attachmentCount > 0) {
    if (isSender) return attachmentCount > 1 ? `You sent ${attachmentCount} attachments` : 'You sent an attachment';
    return attachmentCount > 1 ? `Sent ${attachmentCount} attachments` : 'Sent an attachment';
  }

  const content = normalizeText(message.content);
  if (!content) return null;
  const preview = truncatePreview(content);
  return isSender && message.message_type !== 'system' ? `You: ${preview}` : preview;
}

export function formatServerConversationPreview(
  conversation: ServerPreviewConversation,
  currentUserId?: string | null,
): string | null {
  const preview = normalizeText(conversation.last_message_preview);
  if (!preview) return null;

  const compact = truncatePreview(preview);
  const isSender = Boolean(
    currentUserId && conversation.last_message_sender_id === currentUserId,
  );
  if (!isSender || compact === 'Message deleted' || /^You(?::|\s+sent\b)/i.test(compact)) {
    return compact;
  }
  if (/^Sent(?:\s+an|\s+\d+)?\s+attachments?$/i.test(compact)) {
    return compact.replace(/^Sent/i, 'You sent');
  }
  return `You: ${compact}`;
}

export function createMessagePreviewCandidate(
  message: PreviewSource,
  currentUserId: string | null | undefined,
  source: ConversationPreviewSource,
  revisionAt?: string | null,
): ConversationPreviewCandidate {
  const createdAt = normalizeTimestamp(message.created_at);
  return {
    messageId: String(message.message_id),
    createdAt,
    revisionAt: normalizeTimestamp(revisionAt ?? message.edited_at) ?? createdAt,
    preview: formatConversationPreview(message, currentUserId),
    source,
    viewerId: currentUserId || null,
  };
}

export function createServerPreviewCandidate(
  conversation: ServerPreviewConversation,
  currentUserId?: string | null,
): ConversationPreviewCandidate {
  const serverTimestamp = normalizeTimestamp(conversation.updated_at);
  return {
    messageId: conversation.last_message_id ? String(conversation.last_message_id) : null,
    createdAt: serverTimestamp,
    revisionAt: serverTimestamp,
    preview: formatServerConversationPreview(conversation, currentUserId),
    source: 'server',
    viewerId: currentUserId || null,
  };
}

function shouldAcceptCandidate(
  current: ConversationPreviewEntry | undefined,
  candidate: ConversationPreviewEntry,
) {
  if (!current) return true;
  if (candidate.viewerId !== current.viewerId) return true;

  if (!candidate.messageId) {
    return !current.messageId && SOURCE_PRIORITY[candidate.source] >= SOURCE_PRIORITY[current.source];
  }
  if (!current.messageId) return true;

  if (candidate.messageId === current.messageId) {
    const revisionComparison = compareTimestamp(candidate.revisionAt, current.revisionAt);
    if (revisionComparison !== 0) return revisionComparison > 0;
    if (candidate.source === current.source) {
      return candidate.source === 'live'
        ? candidate.observedOrder > current.observedOrder
        : candidate.preview === current.preview;
    }
    return SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[current.source];
  }

  const createdAtComparison = compareTimestamp(candidate.createdAt, current.createdAt);
  if (createdAtComparison !== 0) return createdAtComparison > 0;

  if (candidate.source === 'live' && current.source === 'live') {
    return candidate.observedOrder > current.observedOrder;
  }
  if (candidate.source === 'live') return true;
  if (current.source === 'live') return false;

  const idComparison = candidate.messageId.localeCompare(current.messageId);
  if (idComparison !== 0) return idComparison > 0;
  return SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[current.source];
}

export class VersionedConversationPreviewState {
  private readonly entries = new Map<string, ConversationPreviewEntry>();
  private observedOrder = 0;

  get(conversationId: string | null | undefined): ConversationPreviewEntry | null {
    if (!conversationId) return null;
    const entry = this.entries.get(conversationId);
    return entry ? { ...entry } : null;
  }

  commit(
    conversationIds: Array<string | null | undefined> | string | null | undefined,
    candidate: ConversationPreviewCandidate,
  ): boolean {
    const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
    const nextEntry: ConversationPreviewEntry = {
      ...candidate,
      observedOrder: ++this.observedOrder,
    };
    let visiblePreviewChanged = false;

    ids.forEach((conversationId) => {
      if (!conversationId) return;
      const current = this.entries.get(conversationId);
      if (!shouldAcceptCandidate(current, nextEntry)) return;
      this.entries.set(conversationId, { ...nextEntry });
      if (!current || current.preview !== nextEntry.preview) {
        visiblePreviewChanged = true;
      }
    });

    return visiblePreviewChanged;
  }
}

export type {
  ConversationPreviewCandidate,
  ConversationPreviewEntry,
  ConversationPreviewSource,
  PreviewSource,
};
