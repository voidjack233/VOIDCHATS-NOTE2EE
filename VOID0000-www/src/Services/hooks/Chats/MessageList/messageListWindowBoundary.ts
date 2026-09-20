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
  getMessageWindowResetKey,
  isCurrentMessageWindowGeneration,
  synchronizeMessageWindowRef,
};
