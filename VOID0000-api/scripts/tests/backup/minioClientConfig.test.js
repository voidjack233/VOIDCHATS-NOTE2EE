import assert from 'node:assert/strict';
import test from 'node:test';
import { minioClientConfig } from '../../backup/minioClientConfig.js';

test('metadata client uses internal HTTP when public MinIO URL is HTTPS', () => {
  const config = minioClientConfig({
    MINIO_ENDPOINT: 'localhost',
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
    MINIO_URL: 'https://cdn.example.test',
    MINIO_ACCESS_KEY: 'test-access',
    MINIO_SECRET_KEY: 'test-secret',
    MINIO_REGION: 'ap-southeast-1',
  });

  assert.equal(`${config.useSSL ? 'https' : 'http'}://${config.endPoint}:${config.port}`, 'http://localhost:9000');
  assert.equal(config.region, 'ap-southeast-1');
});

test('metadata client uses internal HTTPS when explicitly configured', () => {
  const config = minioClientConfig({
    MINIO_ENDPOINT: 'minio.internal',
    MINIO_PORT: '9443',
    MINIO_USE_SSL: 'true',
    MINIO_URL: 'http://cdn.example.test',
  });

  assert.equal(`${config.useSSL ? 'https' : 'http'}://${config.endPoint}:${config.port}`, 'https://minio.internal:9443');
  assert.equal(config.region, 'us-east-1');
});
