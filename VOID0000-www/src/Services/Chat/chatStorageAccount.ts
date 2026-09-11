import { setAuthOperationAccount } from '../Auth/client/authOperationScope';

type AccountListener = (accountId: string | null) => void;
let accountId: string | null = null;
const listeners = new Set<AccountListener>();

export function getChatStorageAccount(): string | null {
  return accountId;
}

export function onChatStorageAccountChange(listener: AccountListener): void {
  listeners.add(listener);
}

export function setChatStorageAccount(next: string | null): void {
  if (next === accountId) return;
  accountId = next;
  setAuthOperationAccount(next);
  listeners.forEach((listener) => listener(next));
}

export function deleteChatDatabase(name: string): void {
  const request = indexedDB.deleteDatabase(name);
  request.onerror = () => console.error('[CHAT_STORAGE] Cache cleanup failed');
}
