import type { MutableRefObject } from 'react';
import type { Message } from '../../../Chat/chatService';

const advanceMessageWindowGeneration = (generationRef: MutableRefObject<number>) => {
  generationRef.current += 1;
  return generationRef.current;
};

const isCurrentMessageWindowGeneration = (
  generationRef: MutableRefObject<number>,
  generation: number,
) => generationRef.current === generation;

const clearMessageWindowLoadingIfOwned = (
  generationRef: MutableRefObject<number>,
  generation: number,
  clearLoading: () => void,
) => {
  if (!isCurrentMessageWindowGeneration(generationRef, generation)) {
    return false;
  }

  clearLoading();
  return true;
};

const synchronizeMessageWindowRef = (
  messagesRef: MutableRefObject<Message[]>,
  messages: Message[],
) => {
  messagesRef.current = messages;
};

const getMessageWindowResetKey = (conversationId: string, windowRevision: number) => (
  `${conversationId}:${windowRevision}`
);

export {
  advanceMessageWindowGeneration,
  clearMessageWindowLoadingIfOwned,
  getMessageWindowResetKey,
  isCurrentMessageWindowGeneration,
  synchronizeMessageWindowRef,
};
