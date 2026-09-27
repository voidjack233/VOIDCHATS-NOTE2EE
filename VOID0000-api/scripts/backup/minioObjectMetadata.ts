import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'minio';

type ObjectManifest = {
  format: 1;
  bucket: string;
  objects: Array<{ key: string; size: number; sha256: string; metadata: Record<string, string> }>;
};

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function streamSha256(stream: AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function usage(): never {
  throw new Error('Usage: minioObjectMetadata.ts capture|restore <bucket> <object-dir> <manifest>');
}

function client(): Client {
  const endPoint = process.env.MINIO_ENDPOINT || '127.0.0.1';
  return new Client({
    endPoint,
    port: Number(process.env.MINIO_PORT || '9000'),
    useSSL: (process.env.MINIO_URL || '').startsWith('https://'),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  });
}

function localObjectPath(objectDirectory: string, key: string): string {
  const resolved = path.resolve(objectDirectory, key);
  if (!resolved.startsWith(`${path.resolve(objectDirectory)}${path.sep}`)) {
    throw new Error(`Unsafe object key in metadata manifest: ${key}`);
  }
  return resolved;
}

async function capture(bucket: string, objectDirectory: string, manifestPath: string): Promise<void> {
  const minio = client();
  const objects: ObjectManifest['objects'] = [];
  for await (const object of minio.listObjectsV2(bucket, '', true)) {
    if (!object.name) continue;
    const objectPath = localObjectPath(objectDirectory, object.name);
    const objectStat = await stat(objectPath);
    const info = await minio.statObject(bucket, object.name);
    objects.push({
      key: object.name,
      size: objectStat.size,
      sha256: await sha256(objectPath),
      metadata: Object.fromEntries(Object.entries(info.metaData || {}).filter(
        ([, value]) => typeof value === 'string',
      )) as Record<string, string>,
    });
  }
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${JSON.stringify({ format: 1, bucket, objects } satisfies ObjectManifest, null, 2)}\n`, { mode: 0o600 });
}

async function restore(bucket: string, objectDirectory: string, manifestPath: string): Promise<void> {
  if (!existsSync(manifestPath)) throw new Error(`Missing MinIO metadata manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ObjectManifest;
  if (manifest.format !== 1 || manifest.bucket !== bucket || !Array.isArray(manifest.objects)) {
    throw new Error(`Invalid MinIO metadata manifest: ${manifestPath}`);
  }
  const minio = client();
  for (const object of manifest.objects) {
    const objectPath = localObjectPath(objectDirectory, object.key);
    const objectStat = await stat(objectPath);
    if (objectStat.size !== object.size || await sha256(objectPath) !== object.sha256) {
      throw new Error(`Object bytes changed after backup: ${object.key}`);
    }
    await minio.putObject(bucket, object.key, createReadStream(objectPath), object.size, object.metadata);
    const restored = await minio.statObject(bucket, object.key);
    if (await streamSha256(await minio.getObject(bucket, object.key)) !== object.sha256) {
      throw new Error(`Restored object bytes do not match backup: ${bucket}/${object.key}`);
    }
    for (const [name, value] of Object.entries(object.metadata)) {
      const restoredValue = Object.entries(restored.metaData || {}).find(
        ([restoredName]) => restoredName.toLowerCase() === name.toLowerCase(),
      )?.[1];
      if (restoredValue !== value) throw new Error(`Metadata verification failed for ${bucket}/${object.key}: ${name}`);
    }
  }
}

const [action, bucket, objectDirectory, manifestPath] = process.argv.slice(2);
if (!action || !bucket || !objectDirectory || !manifestPath) usage();
if (action === 'capture') await capture(bucket, objectDirectory, manifestPath);
else if (action === 'restore') await restore(bucket, objectDirectory, manifestPath);
else usage();
