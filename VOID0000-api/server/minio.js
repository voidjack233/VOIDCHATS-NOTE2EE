// server/minio.js
import * as Minio from 'minio';

const isProduction = process.env.NODE_ENV === 'production';
const accessKey = process.env.MINIO_ACCESS_KEY || (isProduction ? '' : 'minioadmin');
const secretKey = process.env.MINIO_SECRET_KEY || (isProduction ? '' : 'minioadmin');
const minioEndpoint = process.env.MINIO_ENDPOINT || '127.0.0.1';
const minioPort = parseInt(process.env.MINIO_PORT || '9000', 10);
const minioUseSSL = process.env.MINIO_USE_SSL === 'true';
const minioRegion = process.env.MINIO_REGION || 'us-east-1';

if (!accessKey || !secretKey) {
  throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required');
}

if (isProduction && (accessKey === 'minioadmin' || secretKey === 'minioadmin')) {
  throw new Error('Default MinIO credentials are not allowed in production');
}

const minioClient = new Minio.Client({
  endPoint: minioEndpoint,
  port: minioPort,
  useSSL: minioUseSSL,
  accessKey,
  secretKey,
  region: minioRegion,
});

function getCdnMinioClient() {
  const fallbackUrl = isProduction
    ? 'https://cdn.void0000.online'
    : `${minioUseSSL ? 'https' : 'http'}://${minioEndpoint}:${minioPort}`;
  const cdnUrl = new URL(process.env.CDN_URL || fallbackUrl);

  if (
    !['http:', 'https:'].includes(cdnUrl.protocol) ||
    cdnUrl.pathname !== '/' ||
    cdnUrl.username ||
    cdnUrl.password ||
    cdnUrl.search ||
    cdnUrl.hash
  ) {
    throw new Error('CDN_URL must be an HTTP(S) origin without a path');
  }

  return new Minio.Client({
    endPoint: cdnUrl.hostname,
    port: Number(cdnUrl.port) || (cdnUrl.protocol === 'https:' ? 443 : 80),
    useSSL: cdnUrl.protocol === 'https:',
    accessKey,
    secretKey,
    region: minioRegion,
    pathStyle: true,
  });
}

const cdnMinioClient = getCdnMinioClient();

const BUCKET = process.env.MINIO_BUCKET || 'avatars';
const GROUP_AVATAR_BUCKET = process.env.MINIO_GROUP_AVATAR_BUCKET || 'group-avatars';
const ATTACH_BUCKET = process.env.MINIO_ATTACH_BUCKET || 'chat-attachments';

async function ensureBucketExists(bucket) {
  const exists = await minioClient.bucketExists(bucket);
  if (!exists) {
    await minioClient.makeBucket(bucket);
    console.log(`✅ MinIO bucket '${bucket}' created`);
  }
}

function buildPublicReadPolicy(bucket) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucket}/*`],
    }],
  });
}

async function ensurePublicReadBucket(bucket) {
  await ensureBucketExists(bucket);
  await minioClient.setBucketPolicy(bucket, buildPublicReadPolicy(bucket));
  console.log(`✅ MinIO bucket '${bucket}' public read policy set`);
}

async function ensurePrivateBucket(bucket) {
  await ensureBucketExists(bucket);
  try {
    await minioClient.setBucketPolicy(bucket, '');
  } catch (err) {
    const code = err?.code || err?.name || '';
    const message = err?.message || '';
    if (!String(code).includes('NoSuchBucketPolicy') && !message.includes('policy does not exist')) {
      throw err;
    }
  }
  console.log(`✅ MinIO bucket '${bucket}' private policy set`);
}

// Ensure buckets exist on startup
(async () => {
  try {
    await Promise.all([
      ensurePublicReadBucket(BUCKET),
      ensurePublicReadBucket(GROUP_AVATAR_BUCKET),
      ensurePrivateBucket(ATTACH_BUCKET),
    ]);
    console.log('✅ MinIO connected');
  } catch (err) {
    console.error('❌ MinIO init error:', err.message);
  }
})();

export {
  minioClient,
  cdnMinioClient,
  BUCKET,
  GROUP_AVATAR_BUCKET,
  ATTACH_BUCKET,
};
