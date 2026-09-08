// src/Services/Chat/queuedSendStore.ts
//
// Lightweight IndexedDB store for messages waiting on network recovery.
// They survive conversation switches, refreshes, and browser crashes.

import type { LinkPreviewMetadata } from './chatTypes';
import { deleteChatDatabase, getChatStorageAccount, onChatStorageAccountChange } from './chatStorageAccount';

const DB_NAME = 'void_queued_sends';
const DB_VERSION = 1;
const STORE_NAME = 'queued_sends';

export interface QueuedSendRecord {
  conversation_id: string;
  local_client_id: string;
  sender_id: string;
  text: string;
  uploaded_urls: string[];
  reply_to_id: string | null;
  link_preview?: LinkPreviewMetadata | null;
  mentions?: Array<{
    user_id: string;
    username: string;
  }>;
  created_at: string;
}

class QueuedSendStore {
  private db: IDBDatabase | null = null;
  private dbReady: Promise<IDBDatabase> | null = null;
  private active = true;

  constructor(private readonly accountId: string | null) {}

  private get databaseName(): string {
    return `${DB_NAME}:${this.accountId}`;
  }

  retire(): void {
    this.active = false;
    this.db?.close();
    if (this.accountId) deleteChatDatabase(this.databaseName);
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: ['conversation_id', 'local_client_id'],
          });
          store.createIndex('by_conversation', 'conversation_id', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        this.db.onversionchange = () => this.db?.close();
        if (!this.active) this.db.close();
        resolve(this.db);
      };

      request.onerror = () => {
        console.error('[QUEUED_SEND_STORE] Failed to open IndexedDB');
        reject(request.error);
      };
    });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.active || !this.accountId) throw new Error('Chat account is no longer active');
    const db = await (this.dbReady ??= this.open());
    if (!this.active) throw new Error('Chat account is no longer active');
    return db;
  }

  async put(record: QueuedSendRecord): Promise<void> {
    if (record.sender_id !== this.accountId) throw new Error('Queued message owner mismatch');
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async remove(conversationId: string, localClientId: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete([conversationId, localClientId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getByConversation(conversationId: string, userId: string): Promise<QueuedSendRecord[]> {
    if (userId !== this.accountId) return [];
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('by_conversation');
      const request = index.getAll(IDBKeyRange.only(conversationId));
      request.onsuccess = () => resolve((request.result || []).filter((row: QueuedSendRecord) => row.sender_id === userId));
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(userId: string): Promise<QueuedSendRecord[]> {
    if (userId !== this.accountId) return [];
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result || []).filter((row: QueuedSendRecord) => row.sender_id === userId));
      request.onerror = () => reject(request.error);
    });
  }
}

export let queuedSendStore = new QueuedSendStore(getChatStorageAccount());
onChatStorageAccountChange((accountId) => {
  queuedSendStore.retire();
  queuedSendStore = new QueuedSendStore(accountId);
  deleteChatDatabase(DB_NAME);
});
