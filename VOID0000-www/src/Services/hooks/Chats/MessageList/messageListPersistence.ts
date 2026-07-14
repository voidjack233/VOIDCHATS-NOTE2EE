import type { Message } from '../../../Chat/chatService';
import { messageStore, type LocalMessage } from '../../../Chat/chatStore';

function toUIMessage(local: LocalMessage): Message {
  return {
    conversation_id: local.conversation_id,
    message_id: local.message_id,
    sender_id: local.sender_id,
    content: local.is_deleted ? '[deleted]' : String(local.content || ''),
    message_type: local.message_type,
    reply_to: local.reply_to,
    is_edited: local.is_edited,
    edited_at: local.edited_at,
    is_deleted: local.is_deleted,
    created_at: local.created_at,
    reactions: local.reactions || {},
    attachments: local.attachments,
    forwarded: local.forwarded,
    mentions: local.mentions,
    link_preview: local.link_preview,
  };
}

const compareByCreatedAtAsc = (
  a: { created_at: string; message_id: string },
  b: { created_at: string; message_id: string },
) => {
  const difference = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  return difference || a.message_id.localeCompare(b.message_id);
};

const isPendingLocalMessage = (message: Message) => (
  (message.local_status === 'sending' || message.local_status === 'queued') &&
  (Boolean(message.local_client_id) || message.message_id.startsWith('local-'))
);

const sortMessages = (messages: Message[]) => [...messages].sort((left, right) => {
  const leftPending = isPendingLocalMessage(left);
  const rightPending = isPendingLocalMessage(right);
  if (leftPending !== rightPending) return leftPending ? 1 : -1;
  return compareByCreatedAtAsc(left, right);
});

const sortLocalMessages = (messages: LocalMessage[]) => [...messages].sort(compareByCreatedAtAsc);

const toLocalMessages = (messages: Message[]): LocalMessage[] => messages.map((message) => ({
  conversation_id: message.conversation_id,
  message_id: message.message_id,
  sender_id: message.sender_id,
  content: message.content,
  message_type: message.message_type,
  reply_to: message.reply_to,
  is_edited: message.is_edited,
  edited_at: message.edited_at,
  is_deleted: message.is_deleted,
  created_at: message.created_at,
  reactions: message.reactions as Record<string, string[]> || {},
  attachments: message.attachments,
  forwarded: message.forwarded,
  mentions: message.mentions,
  link_preview: message.link_preview,
}));

const persistFetchedMessagesSafely = async (messages: Message[]): Promise<LocalMessage[]> => {
  const localMessages = toLocalMessages(messages);
  if (localMessages.length > 0) await messageStore.putMessages(localMessages);
  return localMessages;
};

const preserveReadableLocalContent = async (messages: LocalMessage[]) => messages;
const mergeLocalMessages = (...pages: LocalMessage[][]): LocalMessage[] => {
  const merged = new Map<string, LocalMessage>();
  pages.flat().forEach((message) => {
    merged.set(message.message_id, { ...merged.get(message.message_id), ...message });
  });
  return sortLocalMessages(Array.from(merged.values()));
};

export {
  mergeLocalMessages,
  persistFetchedMessagesSafely,
  preserveReadableLocalContent,
  sortLocalMessages,
  sortMessages,
  toLocalMessages,
  toUIMessage,
};
