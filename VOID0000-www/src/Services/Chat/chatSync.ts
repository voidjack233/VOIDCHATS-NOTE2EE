import { debugLog } from '../utils/debugLog';
import { getMessages } from './chatService';
import { messageStore } from './chatStore';
import { MessageSync } from './chatSyncCore';

export {
  MESSAGE_SYNC_CACHE_TTL_MS,
  MessageSync,
} from './chatSyncCore';
export type {
  LoadConversationOptions,
  LocalMessageMutationSource,
  MessageFetcher,
  MessageSyncLogger,
  MessageSyncStore,
  SyncResult,
} from './chatSyncCore';

export const messageSync = new MessageSync(
  messageStore,
  getMessages,
  Date.now,
  debugLog,
);
