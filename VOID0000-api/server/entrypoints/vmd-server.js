import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { pool } = await import('../db.js');
const { minioClient, ATTACH_BUCKET } = await import('../minio.js');
const { createReadinessHandler } = await import('../health/readiness.js');
const { getVmdSigningKey } = await import('../vmd/capability.js');
const { default: vmdRouter } = await import('../vmd/index.js');

getVmdSigningKey();

const app = express();
const PORT = process.env.VMD_SERVICE_PORT || 3006;
const HOST = process.env.HOST || process.env.BIND_HOST || '0.0.0.0';

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'voidapp-vmd-service',
    pid: process.pid,
  });
});

app.get('/ready', createReadinessHandler({
  service: 'voidapp-vmd-service',
  checks: {
    postgres: () => pool.query('SELECT 1'),
    minio: () => minioClient.bucketExists(ATTACH_BUCKET),
  },
}));

app.use(vmdRouter);

app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({
    success: false,
    code: 'VMD_ROUTE_NOT_FOUND',
  });
});

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  console.log(`VMD service running on ${HOST}:${PORT} (PID ${process.pid})`);
});
