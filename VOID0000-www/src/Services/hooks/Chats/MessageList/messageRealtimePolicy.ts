import type { Message } from '../../../Chat/chatService';

const REALTIME_MESSAGE_QUEUE_RESULT = Object.freeze({
  hasNewerAfterFlush: false,
  isAtPresentAfterFlush: true,
});

const isRealtimeMessageForConversation = (
  messageConversationId: string | null | undefined,
  activeConversationId: string,
) => String(messageConversationId || '') === String(activeConversationId);

const shouldApplyRealtimeMessageImmediately = ({
  hasUnloadedNewerRange,
  initialHydrationSettled,
  localStatus,
}: {
  hasUnloadedNewerRange: boolean;
  initialHydrationSettled: boolean;
  localStatus?: Message['local_status'];
}) => (
  !initialHydrationSettled ||
  !hasUnloadedNewerRange ||
  localStatus === 'sending' ||
  localStatus === 'queued' ||
  localStatus === 'failed'
);

export {
  REALTIME_MESSAGE_QUEUE_RESULT,
  isRealtimeMessageForConversation,
  shouldApplyRealtimeMessageImmediately,
};
