import type { Message } from '../../../Services/Chat/chatService';
import type { MessageStreamEvent } from '../../../Services/hooks/Chats/MessageList/messageListTypes';

const MAX_SEEN_LIVE_MESSAGE_IDENTITIES = 512;
const isUnconfirmedLocalMessage = (message: Message): boolean => (
  message.local_status === 'sending' ||
  message.local_status === 'queued' ||
  message.local_status === 'failed'
);

const getLiveMessageIdentity = (message: Message): string => (
  String(
    message.local_client_id ||
    message.client_message_id ||
    message.message_id,
  )
);

const rememberLiveMessageIdentity = (seenIdentities: Set<string>, identity: string) => {
  seenIdentities.add(identity);
  while (seenIdentities.size > MAX_SEEN_LIVE_MESSAGE_IDENTITIES) {
    const oldestIdentity = seenIdentities.values().next().value;
    if (typeof oldestIdentity !== 'string') {
      break;
    }
    seenIdentities.delete(oldestIdentity);
  }
};

const selectLiveMessageArrivals = ({
  events,
  lastSequence,
  conversationId,
  currentUserId,
  visibleMessages,
  seenIdentities,
}: {
  events: MessageStreamEvent[];
  lastSequence: number;
  conversationId: string;
  currentUserId?: string;
  visibleMessages: Message[];
  seenIdentities: Set<string>;
}) => {
  const pendingEvents = events.filter((event) => event.sequence > lastSequence);
  if (pendingEvents.length === 0) {
    return {
      lastSequence,
      arrivalMessageIds: [] as string[],
      hasOwnMessageEvent: false,
    };
  }

  const visibleMessagesByIdentity = new Map(
    visibleMessages.map((message) => [getLiveMessageIdentity(message), message]),
  );
  const arrivalMessageIds: string[] = [];
  let hasOwnMessageEvent = false;

  pendingEvents.forEach(({ message }) => {
    if (String(message.conversation_id || conversationId) !== String(conversationId)) {
      return;
    }

    if (message.sender_id === currentUserId) {
      hasOwnMessageEvent = true;
    }

    if (isUnconfirmedLocalMessage(message)) {
      return;
    }

    const identity = getLiveMessageIdentity(message);
    if (seenIdentities.has(identity)) {
      return;
    }

    const visibleMessage = visibleMessagesByIdentity.get(identity);
    const replacesUnconfirmedOwnMessage = (
      message.sender_id === currentUserId &&
      Boolean(visibleMessage && isUnconfirmedLocalMessage(visibleMessage))
    );

    rememberLiveMessageIdentity(seenIdentities, identity);
    if (!visibleMessage || replacesUnconfirmedOwnMessage) {
      arrivalMessageIds.push(String(message.message_id));
    }
  });

  return {
    lastSequence: Math.max(lastSequence, ...pendingEvents.map((event) => event.sequence)),
    arrivalMessageIds,
    hasOwnMessageEvent,
  };
};

export {
  getLiveMessageIdentity,
  selectLiveMessageArrivals,
};
