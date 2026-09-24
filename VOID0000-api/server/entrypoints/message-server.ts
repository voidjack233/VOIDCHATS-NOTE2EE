import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { fromProjectRoot } from '../config/projectRoot.js';
import { securityMiddleware } from '../middleware/xss/index.js';
import { validateAuthSecrets } from '../utils/authSecrets.js';

dotenv.config({ path: fromProjectRoot('.env') });
validateAuthSecrets();

const { encryptedCSRFProtection } = await import('../middleware/encryptedCSRF.js');
const { authenticateUser } = await import('../middleware/jwt.js');
const { messageReactionToggleLimiter } = await import('../middleware/rate_limit.js');
const { noCache } = await import('../middleware/noCache.js');
const { pool } = await import('../db.js');
const {
  assertAttachmentBlobSchemaCompatible,
} = await import('../attachments/schemaCompatibility.js');
const { default: valkey } = await import('../valkey.js');
const { default: scyllaClient } = await import('../scylla.js');
const { minioClient, ATTACH_BUCKET } = await import('../minio.js');
const { default: attachmentsRouter } = await import('../routes/conversations/attachments.js');
const { default: mediaIngestRouter } = await import('../media/ingestRoutes.js');
const { default: batchReactionsRouter } = await import('../routes/conversations/batchReactions.js');
const { default: messagesRouter } = await import('../routes/conversations/messages.js');
const { default: reactionsRouter } = await import('../routes/conversations/reactions.js');
const { createReadinessHandler } = await import('../health/readiness.js');
const { installGracefulHttpShutdown } = await import('../health/gracefulHttpShutdown.js');
const {
  ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
  getAttachmentSanitizerSocketPath,
  pingIpcControlSocket,
} = await import('../attachmentSanitizer/ipcProtocol.js');
const { closePubSub, initPublisher } = await import('../valkey-pubsub.js');
const { default: sentinel } = await import('../sentinel/index.js');
const { historyMetrics } = await import('../health/historyMetrics.js');

const app = express();
const PORT = Number(process.env.MESSAGE_SERVICE_PORT || process.env.PORT || 3002);
const HOST = process.env.HOST || process.env.BIND_HOST || '0.0.0.0';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5173';

await assertAttachmentBlobSchemaCompatible({
  dbPool: pool,
  serviceName: 'voidapp-message-service',
});
// Fail startup rather than accepting uploads against a partially rolled-out schema.
await pool.query('SELECT source_bytes,reserved_bytes FROM media_ingests LIMIT 0');
await pool.query('SELECT video_metadata,poster_blob_id FROM attachment_objects LIMIT 0');

const allowedOrigins = [
  FRONT_URL,
  'https://void0000.online',
  'http://localhost:5173',
  'http://localhost',
];

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
securityMiddleware(allowedOrigins).forEach((mw) => app.use(mw));
const parseJsonBody = express.json({ limit: '25mb' });
app.use((req, res, next) => {
  // A hostile JSON Content-Type must not turn a video upload into a buffered request.
  // Match Express's case-insensitive literal route matching as well.
  if (/\/attachments\/video-ingests\/?(?:\?|$)/i.test(req.url)) { next(); return; }
  parseJsonBody(req, res, next);
});
app.use(cookieParser());

initPublisher();

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-message-service',
    pid: process.pid,
    metrics: { sentinel: sentinel.getSnapshot(), history: historyMetrics.getSnapshot() },
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-message-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    valkey: () => valkey.ping(),
    scylla: () => scyllaClient.execute('SELECT key FROM system.local'),
    minio: () => minioClient.bucketExists(ATTACH_BUCKET),
    attachmentSanitizer: () => pingIpcControlSocket(
      getAttachmentSanitizerSocketPath(),
      ATTACHMENT_SANITIZER_PROTOCOL_VERSION,
    ),
  },
}));

app.use(encryptedCSRFProtection);
app.use('/api/conversations/:conversationId/attachments/video-ingests', noCache, authenticateUser, mediaIngestRouter);
app.use(
  '/api/conversations/:conversationId/messages/:messageId/reactions',
  noCache,
  authenticateUser,
  messageReactionToggleLimiter,
  reactionsRouter
);
app.use(
  '/api/conversations/:conversationId/messages',
  noCache,
  historyMetrics.request,
  historyMetrics.middleware('auth', authenticateUser),
  messagesRouter
);
app.use(
  '/api/conversations/:conversationId/reactions',
  noCache,
  authenticateUser,
  batchReactionsRouter
);
app.use(
  '/api/conversations/:conversationId/attachments',
  noCache,
  authenticateUser,
  attachmentsRouter
);

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  console.log(`✅ Message service running on ${HOST}:${PORT} (PID ${process.pid})`);
});

installGracefulHttpShutdown(httpServer, {
  service: 'Message service',
  hooks: [
    () => closePubSub(),
    () => valkey.quit(),
    () => scyllaClient.shutdown(),
    () => pool.end(),
  ],
});
