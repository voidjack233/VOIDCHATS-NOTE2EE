type EventIdentityPart = string | number;

interface ReactionEventIdentity {
  conversationId: EventIdentityPart;
  messageId: EventIdentityPart;
  emoji: string;
  userId: EventIdentityPart;
  action: string;
}

export function messageEventId(
  messageId: EventIdentityPart | null | undefined,
): string | null {
  return messageId ? `message:${messageId}` : null;
}

export function reactionEventId({
  conversationId,
  messageId,
  emoji,
  userId,
  action,
}: ReactionEventIdentity): string | null {
  if (!conversationId || !messageId || !emoji || !userId || !action) {
    return null;
  }

  return `reaction:${action}:${conversationId}:${messageId}:${emoji}:${userId}`;
}

export function friendshipEventId(
  type: string | null | undefined,
  friendshipId: EventIdentityPart | null | undefined,
): string | null {
  if (!type || !friendshipId) {
    return null;
  }

  return `friendship:${type}:${friendshipId}`;
}
