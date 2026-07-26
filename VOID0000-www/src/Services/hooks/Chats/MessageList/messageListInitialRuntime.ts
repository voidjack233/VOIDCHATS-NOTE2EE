import {
  createEmptyRuntime,
  getRenderedMessages,
  getSavedConversationRuntime,
  type ConversationRuntime,
} from './messageListRuntime';

interface InitialMessageRuntime {
  runtime: ConversationRuntime;
  restored: boolean;
}

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
