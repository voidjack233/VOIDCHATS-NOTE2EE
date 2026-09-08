import { debugLog } from '../utils/debugLog';
import { getMessages } from './chatService';
import { messageStore } from './chatStore';
import { MessageSync } from './chatSyncCore';
import { messagesNeedAttachmentDeliveryRefresh } from './attachmentDeliveryFreshness';
import { onChatStorageAccountChange } from './chatStorageAccount';

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

function createMessageSync() { return new MessageSync(
  messageStore,
  getMessages,
  Date.now,
  debugLog,
  messagesNeedAttachmentDeliveryRefresh,
); }

export let messageSync = createMessageSync();
onChatStorageAccountChange(() => { messageSync = createMessageSync(); });
