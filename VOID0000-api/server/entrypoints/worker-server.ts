import dotenv from 'dotenv';
import { fromProjectRoot } from '../config/projectRoot.js';

dotenv.config({ path: fromProjectRoot('.env') });

const { initPublisher, closePubSub } = await import('../valkey-pubsub.js');
const { initPresenceFanout, closePresenceFanout } = await import('../gateway/presence-fanout.js');
const { startImageWorker, closeImageQueueResources } = await import('../queues/imageQueue.js');
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
  shutdownScyllaClient,
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

let cleanupPromise: Promise<void> | null = null;
function runCleanup(): Promise<void> {
  cleanupPromise ??= cleanupAllExpired()
    .then(() => { console.log('✅ Expired data cleanup done'); })
    .catch((error) => { console.error('❌ Expired data cleanup failed:', error); })
    .finally(() => { cleanupPromise = null; });
  return cleanupPromise;
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

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Worker service received ${signal}, shutting down...`);
  // Match the existing PM2 budget. A stalled drain or forgotten handle is a
  // failed shutdown; healthy shutdown ends naturally without this firing.
  const deadline = setTimeout(() => {
    console.error('Worker shutdown timed out');
    process.exit(1);
  }, 10_000);
  // BullMQ reports some close failures through its error event instead of
  // rejecting close(). Preserve a failed status for either reporting path.
  const recordWorkerError = (error: Error) => {
    console.error('Worker shutdown failed:', error);
    process.exitCode = 1;
  };
  imageWorker.on('error', recordWorkerError);

  async function closeResources(tasks: Array<() => unknown | PromiseLike<unknown>>) {
    const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Worker shutdown failed:', result.reason);
        process.exitCode = 1;
      }
    }
  }

  clearInterval(cleanupInterval);
  // Each owner stops intake immediately and drains work before dependencies
  // close. BullMQ close() waits for current jobs and records their completion.
  await closeResources([
    () => attachmentReservationReconciliation.stop(),
    () => stagedAttachmentCleanup.stop(),
    () => cleanupPromise,
    () => closePresenceFanout(),
    () => attachmentSanitizerServer.close(),
    () => vmdTransformServer.close(),
    () => imageWorker.close(),
  ]);
  imageWorker.off('error', recordWorkerError);
  await closeResources([() => closeImageQueueResources()]);
  await closeResources([() => closePubSub(), () => valkey.quit()]);
  await closeResources([() => shutdownScyllaClient()]);
  await closeResources([() => pool.end()]);
  await closeResources([() => { if (process.connected) process.disconnect(); }]);
  // Keep the failure watchdog only while another resource holds the loop open.
  deadline.unref();
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
