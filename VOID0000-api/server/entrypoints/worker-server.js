import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { initPublisher } = await import('../valkey-pubsub.js');
const { initPresenceFanout } = await import('../gateway/presence-fanout.js');
const { startImageWorker } = await import('../queues/imageQueue.js');
const {
  startAttachmentSanitizerServer,
} = await import('../attachmentSanitizer/server.js');
const {
  startVmdTransformServer,
} = await import('../vmd/transformServer.js');
const {
  createStagedAttachmentCleanupRunner,
} = await import('../attachments/cleanup.js');
const {
  attachmentLifecycle,
} = await import('../attachments/lifecycle.js');
const {
  assertAttachmentBlobSchemaCompatible,
} = await import('../attachments/schemaCompatibility.js');
const {
  createAttachmentReservationReconciler,
  createAttachmentReservationReconciliationRunner,
  createPostgresAttachmentReservationStore,
  createScyllaAttachmentMessageReader,
} = await import('../attachments/reservationReconciliation.js');
const { pool } = await import('../db.js');
const {
  cassandra,
  default: scylla,
} = await import('../scylla.js');
const {
  resolveMessageStorageConversation,
} = await import('../utils/messageConversation.js');
const { default: valkey } = await import('../valkey.js');
const { cleanupAllExpired } = await import('../utils/cleanUpExpired.js');

await assertAttachmentBlobSchemaCompatible({
  dbPool: pool,
  serviceName: 'voidapp-worker-service',
});

initPublisher();
initPresenceFanout();

const attachmentSanitizerServer = await startAttachmentSanitizerServer();
const vmdTransformServer = await startVmdTransformServer();
const imageWorker = startImageWorker();
const stagedAttachmentCleanup = createStagedAttachmentCleanupRunner({
  lifecycle: attachmentLifecycle,
  lockClient: valkey,
});
const attachmentReservationStore = createPostgresAttachmentReservationStore({
  dbPool: pool,
  freshStagedTtlSeconds: attachmentLifecycle.config.reservationTtlSeconds,
});
const attachmentMessageReader = createScyllaAttachmentMessageReader({
  dbPool: pool,
  scyllaClient: scylla,
  cassandraDriver: cassandra,
  resolveStorageConversation: resolveMessageStorageConversation,
});
const attachmentReservationReconciler = createAttachmentReservationReconciler({
  ...attachmentReservationStore,
  loadStoredMessage: attachmentMessageReader,
  batchSize: attachmentLifecycle.config.reconciliationBatchSize,
});
const attachmentReservationReconciliation =
  createAttachmentReservationReconciliationRunner({
    reconciler: attachmentReservationReconciler,
    lockClient: valkey,
    intervalSeconds: attachmentLifecycle.config.cleanupIntervalSeconds,
  });

async function runCleanup() {
  try {
    await cleanupAllExpired();
    console.log('✅ Expired data cleanup done');
  } catch (error) {
    console.error('❌ Expired data cleanup failed:', error);
  }
}

await runCleanup();
const cleanupInterval = setInterval(runCleanup, 6 * 60 * 60 * 1000);
await attachmentReservationReconciliation.runOnce().catch((error) => {
  console.error('❌ Initial attachment reservation reconciliation failed:', error);
});
await stagedAttachmentCleanup.runOnce().catch((error) => {
  console.error('❌ Initial staged attachment cleanup failed:', error);
});
attachmentReservationReconciliation.start();
stagedAttachmentCleanup.start();

async function shutdown(signal) {
  console.log(`Worker service received ${signal}, shutting down...`);
  clearInterval(cleanupInterval);
  attachmentReservationReconciliation.stop();
  stagedAttachmentCleanup.stop();
  await Promise.allSettled([
    attachmentSanitizerServer.close(),
    vmdTransformServer.close(),
    imageWorker.close(),
  ]).then((results) => {
    const [attachmentResult, vmdResult, imageResult] = results;
    if (attachmentResult.status === 'rejected') {
      console.error('Attachment sanitizer shutdown failed:', attachmentResult.reason);
    }
    if (vmdResult.status === 'rejected') {
      console.error('VMD transform shutdown failed:', vmdResult.reason);
    }
    if (imageResult.status === 'rejected') {
      console.error('Image worker shutdown failed:', imageResult.reason);
    }
  });
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

console.log(
  `✅ Worker service running (PID ${process.pid}, attachment IPC ${attachmentSanitizerServer.socketPath}, VMD IPC ${vmdTransformServer.socketPath})`,
);
