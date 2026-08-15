import {
  createEmptyRuntime,
  getRenderedMessages,
  getSavedConversationRuntime,
  type ConversationRuntime,
} from './messageListRuntime';
import type { LocalMessage } from '../../../Chat/chatStore';

interface CachedMessageIdentity {
  message_id: string;
}

interface OrderedCachedMessageIdentity extends CachedMessageIdentity {
  created_at: string;
}

interface InitialMessageRuntime {
  runtime: ConversationRuntime;
  restored: boolean;
}

export const canSettleInitialHydrationFromCachedWindow = (
  messages: readonly CachedMessageIdentity[],
) => messages.length > 0;

export const hasCachedMessagesAfterWindow = (
  windowMessages: readonly OrderedCachedMessageIdentity[],
  latestMessages: readonly OrderedCachedMessageIdentity[],
) => {
  const windowNewest = windowMessages.at(-1);
  const latestNewest = latestMessages.at(-1);
  if (!windowNewest || !latestNewest) return false;

  const createdAtDifference = new Date(latestNewest.created_at).getTime() -
    new Date(windowNewest.created_at).getTime();
  return createdAtDifference > 0 || (
    createdAtDifference === 0 && latestNewest.message_id.localeCompare(windowNewest.message_id) > 0
  );
};

interface CachedMessagePage {
  messages: LocalMessage[];
  has_more: boolean;
}

export const createCachedHistoricalWindow = ({
  anchor,
  before,
  after,
}: {
  anchor: LocalMessage | null;
  before: CachedMessagePage;
  after: CachedMessagePage;
}) => {
  if (!anchor) return null;

  const messagesById = new Map<string, LocalMessage>();
  [...before.messages, anchor, ...after.messages].forEach((message) => {
    messagesById.set(message.message_id, message);
  });
  const messages = Array.from(messagesById.values()).sort((left, right) => {
    const createdAtDifference = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    return createdAtDifference || left.message_id.localeCompare(right.message_id);
  });

  return {
    messages,
    hasOlder: before.has_more,
    hasNewer: after.has_more,
  };
};

export const resolveInitialMessageRuntime = (
  conversationId: string,
  historyAccessFenceSignature: string,
): InitialMessageRuntime => {
  const savedRuntime = historyAccessFenceSignature === 'none'
    ? getSavedConversationRuntime(conversationId)
    : null;
  const restored = Boolean(savedRuntime && getRenderedMessages(savedRuntime).length > 0);

  return {
    runtime: restored && savedRuntime
      ? savedRuntime
      : createEmptyRuntime(conversationId),
    restored,
  };
};

export type { InitialMessageRuntime };
