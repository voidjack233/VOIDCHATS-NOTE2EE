import { useCallback, useEffect, useRef, useState } from 'react';
import { getMessageById, type Message } from '../../../Chat/chatService';
import { messageStore, type LocalMessage } from '../../../Chat/chatStore';
import { type HistoryAccessFence, isMessageVisibleForHistoryFence } from './messageListHistory';
import { toUIMessage } from './messageListPersistence';

interface UseMessageListRepliesParams {
  messages: Message[];
  conversationId: string;
  historyAccessFence: HistoryAccessFence | null;
}

const UNAVAILABLE_REPLY_CONTENT = '[deleted or unavailable]';

const createUnavailableReply = (conversationId: string, replyToId: string): Message => ({
  conversation_id: conversationId,
  message_id: replyToId,
  sender_id: '',
  message_type: 'system',
  reply_to: null,
  attachments: [],
  is_edited: false,
  edited_at: null,
  is_deleted: true,
  created_at: new Date(0).toISOString(),
  content: UNAVAILABLE_REPLY_CONTENT,
  reactions: {},
});

const hasRenderableReplyPreview = (message: Message | LocalMessage): boolean => (
  Boolean(
    message.is_deleted ||
    message.message_type === 'system' ||
    message.content?.trim() ||
    message.attachments?.length
  )
);

const useMessageListReplies = ({
  messages,
  conversationId,
  historyAccessFence,
}: UseMessageListRepliesParams) => {
  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const [fetchingReplyIds, setFetchingReplyIds] = useState<Set<string>>(new Set());
  const fetchingReplies = useRef<Set<string>>(new Set());
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setReplyCache({});
    setFetchingReplyIds(new Set());
    fetchingReplies.current.clear();
  }, [conversationId]);

  const getReplyParent = useCallback((replyToId: string): Message | null => (
    messages.find((message) => message.message_id === replyToId) || replyCache[replyToId] || null
  ), [messages, replyCache]);

  const isReplyParentLoading = useCallback((replyToId: string): boolean => (
    fetchingReplyIds.has(replyToId)
  ), [fetchingReplyIds]);

  useEffect(() => {
    const missingReplies = Array.from(new Set(
      messages
        .map((message) => message.reply_to)
        .filter((replyToId): replyToId is string => (
          typeof replyToId === 'string' && replyToId.length > 0 &&
          !messages.some((message) => message.message_id === replyToId) &&
          !replyCache[replyToId] &&
          !fetchingReplies.current.has(replyToId)
        )),
    ));

    missingReplies.forEach((replyToId) => {
      const requestGeneration = requestGenerationRef.current;
      fetchingReplies.current.add(replyToId);
      setFetchingReplyIds((previous) => new Set(previous).add(replyToId));

      const cacheReply = (message?: Message | LocalMessage | null) => {
        if (requestGeneration !== requestGenerationRef.current) return;

        const uiMessage = message ? toUIMessage(message as LocalMessage) : null;
        const reply = uiMessage &&
          hasRenderableReplyPreview(uiMessage) &&
          isMessageVisibleForHistoryFence(uiMessage, historyAccessFence)
          ? uiMessage
          : createUnavailableReply(conversationId, replyToId);
        setReplyCache((previous) => ({ ...previous, [replyToId]: reply }));
      };

      messageStore.getMessage(conversationId, replyToId)
        .then(async (localMessage) => {
          if (localMessage && hasRenderableReplyPreview(localMessage)) {
            cacheReply(localMessage);
            return;
          }

          const message = await getMessageById(conversationId, replyToId);
          cacheReply(message);
        })
        .catch(() => cacheReply())
        .finally(() => {
          if (requestGeneration !== requestGenerationRef.current) return;
          fetchingReplies.current.delete(replyToId);
          setFetchingReplyIds((previous) => {
            const next = new Set(previous);
            next.delete(replyToId);
            return next;
          });
        });
    });
  }, [conversationId, historyAccessFence, messages, replyCache]);

  return { getReplyParent, isReplyParentLoading };
};

export { useMessageListReplies };
