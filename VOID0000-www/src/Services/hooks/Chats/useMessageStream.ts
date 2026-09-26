import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '../../Chat/chatService';
import { subscribeQueuedSendOutcomes } from '../../Chat/queuedSendRecovery';
import { gateway } from '../../Gateway/gateway';
import type { MessageStreamEvent, MessageUpdate } from './MessageList/messageListTypes';
import { normalizeMessageUpdate } from './MessageList/messageUpdatePatch';

interface UseMessageStreamParams {
  activeConversation: Conversation | null;
  user: { id: string } | null | undefined;
  clearUserTyping: (userId: string) => void;
}

function normalizeLiveMessage(data: Message): Message {
  return {
    ...data,
    content: data?.is_deleted ? '[deleted]' : String(data?.content || ''),
    local_client_id: data?.local_client_id ?? data?.client_message_id ?? undefined,
    client_message_id: data?.client_message_id ?? data?.local_client_id ?? undefined,
  } as Message;
}

export const useMessageStream = ({
  activeConversation,
  user,
  clearUserTyping,
}: UseMessageStreamParams) => {
  const [messageEvents, setMessageEvents] = useState<MessageStreamEvent[]>([]);
  const [messageUpdate, setMessageUpdate] = useState<MessageUpdate | null>(null);
  const [messageDelete, setMessageDelete] = useState<{ message_id: string } | null>(null);
  const sequenceRef = useRef(0);

  const pushMessageEvent = useCallback((message: Message) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setMessageEvents((previous) => [...previous, { sequence, message }]);
  }, []);

  useEffect(() => {
    if (!user?.id || !activeConversation?.id) return;

    const handleCreate = (data: Message) => {
      if (String(data?.conversation_id) !== String(activeConversation.id)) return;
      if (data?.sender_id) clearUserTyping(String(data.sender_id));
      pushMessageEvent(normalizeLiveMessage(data));
    };
    const handleUpdate = (data: Partial<Message>) => {
      if (String(data?.conversation_id) !== String(activeConversation.id)) return;
      setMessageUpdate(normalizeMessageUpdate(data));
    };
    const handleDelete = (data: Pick<Message, 'conversation_id' | 'message_id'>) => {
      if (String(data?.conversation_id) === String(activeConversation.id)) {
        setMessageDelete({ message_id: String(data.message_id) });
      }
    };
    const unsubscribeQueuedSends = subscribeQueuedSendOutcomes((outcome) => {
      if (
        outcome.record.sender_id === user.id &&
        String(outcome.record.conversation_id) === String(activeConversation.id)
      ) {
        pushMessageEvent(outcome.message);
      }
    });

    gateway.on('MESSAGE_CREATE', handleCreate);
    gateway.on('MESSAGE_UPDATE', handleUpdate);
    gateway.on('MESSAGE_DELETE', handleDelete);
    return () => {
      gateway.off('MESSAGE_CREATE', handleCreate);
      gateway.off('MESSAGE_UPDATE', handleUpdate);
      gateway.off('MESSAGE_DELETE', handleDelete);
      unsubscribeQueuedSends();
    };
  }, [activeConversation?.id, clearUserTyping, pushMessageEvent, user?.id]);

  const resetMessageStream = useCallback(() => {
    setMessageEvents([]);
    setMessageUpdate(null);
    setMessageDelete(null);
    sequenceRef.current = 0;
  }, []);

  return {
    messageEvents,
    messageUpdate,
    messageDelete,
    pushMessageEvent,
    setMessageUpdate,
    resetMessageStream,
  };
};
