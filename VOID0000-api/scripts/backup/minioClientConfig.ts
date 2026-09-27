export function minioClientConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    endPoint: env.MINIO_ENDPOINT || '127.0.0.1',
    port: Number(env.MINIO_PORT || '9000'),
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey: env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: env.MINIO_SECRET_KEY || 'minioadmin',
    region: env.MINIO_REGION || 'us-east-1',
  };
}
