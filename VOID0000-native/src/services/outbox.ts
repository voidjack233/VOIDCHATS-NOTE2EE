import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PickedAttachment } from '../types/models';

const OUTBOX_KEY = 'void_native_message_outbox';

export interface OutboxJob {
  userId: string;
  clientId: string;
  conversationId: string;
  content: string;
  attachments: PickedAttachment[];
  replyTo: string | null;
  createdAt: string;
}

let mutation = Promise.resolve();

async function read(): Promise<OutboxJob[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is OutboxJob => Boolean(
      item &&
      typeof item === 'object' &&
      typeof (item as OutboxJob).userId === 'string' &&
      typeof (item as OutboxJob).clientId === 'string' &&
      typeof (item as OutboxJob).conversationId === 'string',
    )) : [];
  } catch {
    return [];
  }
}

async function write(jobs: OutboxJob[]) {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(jobs.slice(-100)));
}

function serialized(operation: () => Promise<void>) {
  mutation = mutation.then(operation, operation);
  return mutation;
}

export const outbox = {
  async list(userId: string, conversationId?: string) {
    await mutation;
    const jobs = await read();
    return jobs.filter((job) =>
      job.userId === userId && (!conversationId || job.conversationId === conversationId),
    );
  },

  upsert(job: OutboxJob) {
    return serialized(async () => {
      const jobs = await read();
      await write([...jobs.filter((item) => item.clientId !== job.clientId), job]);
    });
  },

  remove(userId: string, clientId: string) {
    return serialized(async () => {
      const jobs = await read();
      await write(jobs.filter((job) => job.userId !== userId || job.clientId !== clientId));
    });
  },

  clear() {
    return serialized(() => AsyncStorage.removeItem(OUTBOX_KEY));
  },
};
