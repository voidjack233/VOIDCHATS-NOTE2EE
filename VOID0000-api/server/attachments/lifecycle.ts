import { pool } from '../db.js';
import { ATTACH_BUCKET, minioClient } from '../minio.js';
import {
  createAttachmentLifecycle,
  resolveAttachmentLifecycleConfig,
} from './lifecycleCore.js';

export * from './lifecycleCore.js';

const lifecycleOptions = {
  dbPool: pool,
  objectStore: minioClient,
  bucket: ATTACH_BUCKET,
  config: resolveAttachmentLifecycleConfig(),
};

export const attachmentLifecycle = createAttachmentLifecycle(lifecycleOptions);
