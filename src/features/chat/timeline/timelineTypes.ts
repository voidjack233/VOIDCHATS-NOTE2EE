import type { ReactNode } from 'react';

export type TimelineMessageStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface TimelineImage {
  uri: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface TimelineMessage {
  id: string;
  senderId: string;
  senderName: string;
  createdAt: string;
  text?: string;
  image?: TimelineImage;
  status?: TimelineMessageStatus;
  /** Changes whenever rendered row geometry may have changed. */
  layoutVersion?: string;
  itemType?: string;
}

export interface TimelineRenderInfo {
  message: TimelineMessage;
  index: number;
  highlighted: boolean;
  onHeightWillChange: () => void;
}

export interface TimelineColors {
  background: string;
  surface: string;
  border: string;
  text: string;
  accent: string;
}

export interface TimelineVisibleRange {
  firstMessageId: string | null;
  lastMessageId: string | null;
  firstIndex: number | null;
  lastIndex: number | null;
}

export type TimelineHistoryPhase =
  | 'idle'
  | 'captured'
  | 'loading'
  | 'committed'
  | 'restoring';

export interface TimelineState {
  initialRestoreComplete: boolean;
  isAtPresent: boolean;
  showJumpToPresent: boolean;
  isLoadingHistory: boolean;
  historyPhase: TimelineHistoryPhase;
  pendingJumpMessageId: string | null;
  highlightedMessageId: string | null;
}

export interface JumpToMessageOptions {
  animated?: boolean;
}

export interface JumpToPresentOptions {
  animated?: boolean;
}

export interface NativeMessageTimelineHandle {
  jumpToMessage(
    messageId: string,
    options?: JumpToMessageOptions,
  ): Promise<boolean>;
  jumpToPresent(options?: JumpToPresentOptions): Promise<void>;
  loadOlder(): Promise<boolean>;
  getState(): TimelineState;
}

interface NativeMessageTimelineBaseProps {
  conversationId: string;
  messages: readonly TimelineMessage[];
  currentUserId: string;
  colors: TimelineColors;
  renderMessage: (info: TimelineRenderInfo) => ReactNode;
  getItemType?: (message: TimelineMessage) => string;
  /** Set true only after the conversation's first page (including an empty page) resolves. */
  initialDataReady: boolean;
  hasOlder: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  loadOlder?: () => Promise<void>;
  /** Loads the next newer page when a bounded history window is in use. */
  loadNewer?: () => Promise<void>;
  /** Marks locally produced appends that must follow even while reading history. */
  shouldForceFollowOnAppend?: (message: TimelineMessage) => boolean;
  onLoadError?: (direction: 'older' | 'newer', error: unknown) => void;
  onVisibleRangeChange?: (range: TimelineVisibleRange) => void;
  onStateChange?: (state: TimelineState) => void;
  emptyLabel?: string;
  testID?: string;
}

export type NativeMessageTimelineProps = NativeMessageTimelineBaseProps &
  (
    | {
        hasNewer?: false;
        loadLatest?: never;
      }
    | {
        hasNewer: boolean;
        /** Must resolve after requesting the window through the latest message. */
        loadLatest: () => Promise<void>;
      }
  );
