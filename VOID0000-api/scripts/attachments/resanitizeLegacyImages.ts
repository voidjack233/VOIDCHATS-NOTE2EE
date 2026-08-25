#!/usr/bin/env node

import { access, mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client as CassandraClient, types as CassandraTypes } from 'cassandra-driver';
import dotenv from 'dotenv';
import {
  CopyDestinationOptions,
  CopySourceOptions,
} from 'minio';
import type { Client as MinioClient } from 'minio';
import type { Pool, QueryResultRow } from 'pg';

import {
  getLegacyDescriptorAttachmentId,
  MAX_CHAT_ATTACHMENT_BYTES,
  parseLegacyAttachmentDescriptor,
  runLegacyImageMigration,
  summarizeLegacyImageMigration,
} from './legacyImageMigrationCore.js';
import type {
  LegacyAttachmentDescriptor,
  LegacyAttachmentRow,
  LegacyDescriptorReference,
  LegacyMessageRecord,
  LegacyMigrationDependencies,
  LegacyMigrationRecord,
  LegacyObjectStore,
} from './legacyImageMigrationCore.js';
import { projectRoot } from '../../server/config/projectRoot.js';
import type { MessageStorageConversation } from '../../server/utils/messageConversation.js';

const API_ROOT = projectRoot;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;
const SCYLLA_PAGE_SIZE = 500;

type CassandraDriverModule = typeof import('cassandra-driver');
type ResolveMessageStorageConversation = typeof import(
  '../../server/utils/messageConversation.js'
)['resolveMessageStorageConversation'];
type AttachSignedAttachmentUrls = typeof import(
  '../../server/utils/attachmentDelivery.js'
)['attachSignedAttachmentUrls'];

interface ParsedLegacyImageMigrationOptions {
  apply: boolean;
  limit: number;
  attachmentId: string | null;
  attachmentIdsFile: string | null;
  attachmentIds: string[] | null;
  conversationId: string | null;
  resumeFrom: string | null;
  reportPath: string;
}

interface MutableLegacyImageMigrationOptions extends Omit<
  ParsedLegacyImageMigrationOptions,
  'reportPath'
> {
  reportPath: string | null;
}

interface LegacyAttachmentDbRow extends QueryResultRow, LegacyAttachmentRow {}

interface DescriptorResolverInput {
  pool: Pool;
  scylla: CassandraClient;
  cassandra: CassandraDriverModule;
  resolveMessageStorageConversation: ResolveMessageStorageConversation;
  selectedRows: LegacyAttachmentRow[];
}

interface DescriptorUpdate {
  messageRecord: LegacyMessageRecord;
  originalAttachments: unknown[];
  nextAttachments: unknown[];
  updatedCount: number;
}

function setErrorCode(error: Error, code: string): void {
  Reflect.set(error, 'code', code);
}

function getErrorCode(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object') {
    return String(
      Reflect.get(error, 'code') || Reflect.get(error, 'name') || fallback,
    );
  }
  return fallback;
}

dotenv.config({ path: path.join(API_ROOT, '.env') });

function readOptionValue(
  argv: string[],
  index: number,
  optionName: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw new Error(`${optionName} must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function parseUuid(value: string, optionName: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${optionName} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseLegacyImageMigrationArgs(
  argv: string[],
): ParsedLegacyImageMigrationOptions {
  const options: MutableLegacyImageMigrationOptions = {
    apply: false,
    limit: DEFAULT_LIMIT,
    attachmentId: null,
    attachmentIdsFile: null,
    attachmentIds: null,
    conversationId: null,
    resumeFrom: null,
    reportPath: null,
  };
  let explicitDryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      explicitDryRun = true;
      continue;
    }
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--limit') {
      options.limit = parsePositiveInteger(
        readOptionValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === '--attachment-id') {
      options.attachmentId = parseUuid(
        readOptionValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === '--attachment-ids-file') {
      options.attachmentIdsFile = path.resolve(
        readOptionValue(argv, index, argument),
      );
      index += 1;
      continue;
    }
    if (argument === '--conversation-id') {
      options.conversationId = parseUuid(
        readOptionValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === '--resume-from') {
      options.resumeFrom = parseUuid(
        readOptionValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === '--report') {
      options.reportPath = path.resolve(
        readOptionValue(argv, index, argument),
      );
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (explicitDryRun && options.apply) {
    throw new Error('--dry-run and --apply cannot be used together');
  }
  if (
    options.attachmentIdsFile &&
    (options.attachmentId || options.conversationId || options.resumeFrom)
  ) {
    throw new Error(
      '--attachment-ids-file cannot be combined with attachment, conversation, or resume filters',
    );
  }

  if (!options.reportPath) {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    options.reportPath = path.join(
      os.tmpdir(),
      'void-legacy-attachment-reports',
      `legacy-images-${timestamp}.jsonl`,
    );
  }

  return {
    ...options,
    reportPath: options.reportPath,
  };
}

export async function readApprovedAttachmentIds(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, 'utf8');
  let rawIds: unknown;

  try {
    const parsed = JSON.parse(contents);
    rawIds = Array.isArray(parsed) ? parsed : null;
  } catch {
    rawIds = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error('--attachment-ids-file must contain at least one attachment UUID');
  }
  if (rawIds.length > MAX_LIMIT) {
    throw new Error(`--attachment-ids-file cannot contain more than ${MAX_LIMIT} UUIDs`);
  }

  const attachmentIds = rawIds.map((value) => (
    parseUuid(String(value), '--attachment-ids-file')
  ));
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('--attachment-ids-file contains duplicate attachment UUIDs');
  }
  return attachmentIds;
}

async function listAttachmentObjects(
  pool: Pool,
  bucket: string,
  options: ParsedLegacyImageMigrationOptions,
): Promise<LegacyAttachmentDbRow[]> {
  const conditions = ['bucket = $1'];
  const values: unknown[] = [bucket];

  if (Array.isArray(options.attachmentIds)) {
    values.push(options.attachmentIds);
    conditions.push(`id = ANY($${values.length}::uuid[])`);
  } else if (options.attachmentId) {
    values.push(options.attachmentId);
    conditions.push(`id = $${values.length}::uuid`);
  }
  if (options.conversationId) {
    values.push(options.conversationId);
    conditions.push(`conversation_id = $${values.length}::uuid`);
  }
  if (options.resumeFrom) {
    values.push(options.resumeFrom);
    conditions.push(`id::text > $${values.length}`);
  }
  values.push(options.limit);

  const result = await pool.query<LegacyAttachmentDbRow>(
    `SELECT
       id::text AS id,
       conversation_id::text AS conversation_id,
       uploader_id::text AS uploader_id,
       bucket,
       object_key,
       created_at
     FROM attachment_objects
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY id::text ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

function assertExactAttachmentSelection(
  rows: LegacyAttachmentRow[],
  expectedAttachmentIds: string[] | null,
): void {
  if (!Array.isArray(expectedAttachmentIds)) return;

  const actual = rows.map((row) => String(row.id).toLowerCase()).sort();
  const expected = [...expectedAttachmentIds].sort();
  if (
    actual.length !== expected.length ||
    actual.some((attachmentId, index) => attachmentId !== expected[index])
  ) {
    const error = new Error(
      `Attachment allowlist selected ${actual.length} of ${expected.length} required rows`,
    );
    setErrorCode(error, 'LEGACY_IMAGE_ALLOWLIST_MISMATCH');
    throw error;
  }
}

function createDescriptorResolver({
  pool,
  scylla,
  cassandra,
  resolveMessageStorageConversation,
  selectedRows,
}: DescriptorResolverInput): LegacyMigrationDependencies['findDescriptorReferences'] {
  const selectedIdsByConversation = new Map<string, Set<string>>();
  const cache = new Map<
    string,
    Promise<Map<string, LegacyDescriptorReference[]>>
  >();

  selectedRows.forEach((row) => {
    const conversationId = String(row.conversation_id);
    const selectedIds = selectedIdsByConversation.get(conversationId) || new Set();
    selectedIds.add(String(row.id).toLowerCase());
    selectedIdsByConversation.set(conversationId, selectedIds);
  });

  async function loadConversationReferences(
    conversationId: string,
  ): Promise<Map<string, LegacyDescriptorReference[]>> {
    const conversationResult = await pool.query<MessageStorageConversation>(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, slowmode_seconds
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [conversationId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return new Map<string, LegacyDescriptorReference[]>();

    const storageConversation = await resolveMessageStorageConversation(
      conversation,
      pool,
    );
    const storageConversationId = String(storageConversation?.id || conversationId);
    const conversationUuid = cassandra.types.Uuid.fromString(storageConversationId);
    const selectedIds = selectedIdsByConversation.get(conversationId) || new Set();
    const referencesById = new Map<string, LegacyDescriptorReference[]>();
    selectedIds.forEach((attachmentId) => {
      referencesById.set(attachmentId, []);
    });
    let pageState: string | null = null;

    do {
      const result: CassandraTypes.ResultSet = await scylla.execute(
        `SELECT message_id, attachments
         FROM messages
         WHERE conversation_id = ?`,
        [conversationUuid],
        {
          prepare: true,
          fetchSize: SCYLLA_PAGE_SIZE,
          ...(pageState ? { pageState } : {}),
        },
      );

      for (const row of result.rows || []) {
        const messageRecord = {
          storageConversationId,
          messageId: String(row.message_id),
          attachments: Array.isArray(row.attachments) ? [...row.attachments] : [],
        };

        messageRecord.attachments.forEach((rawAttachment, index) => {
          const descriptor = parseLegacyAttachmentDescriptor(rawAttachment);
          const attachmentId = getLegacyDescriptorAttachmentId(descriptor);
          if (!descriptor || !attachmentId || !referencesById.has(attachmentId)) return;

          referencesById.get(attachmentId)?.push({
            descriptor,
            index,
            messageRecord,
          });
        });
      }

      pageState = result.pageState || null;
    } while (pageState);

    return referencesById;
  }

  return async function findDescriptorReferences(row: LegacyAttachmentRow) {
    const conversationId = String(row.conversation_id);
    let referencesPromise = cache.get(conversationId);
    if (!referencesPromise) {
      referencesPromise = loadConversationReferences(conversationId);
      cache.set(conversationId, referencesPromise);
    }
    const referencesById = await referencesPromise;
    return referencesById.get(String(row.id).toLowerCase()) || [];
  };
}

function createObjectStore(
  minioClient: MinioClient,
  bucket: string,
): LegacyObjectStore {
  return {
    statObject(objectKey: string) {
      return minioClient.statObject(bucket, objectKey);
    },

    async readObject(objectKey: string, maxBytes: number): Promise<Buffer> {
      const stream = await minioClient.getObject(bucket, objectKey);
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maxBytes) {
          stream.destroy();
          const error = new Error('Legacy attachment exceeds the existing source byte limit');
          setErrorCode(error, 'ATTACHMENT_TOO_LARGE');
          throw error;
        }
        chunks.push(buffer);
      }

      return Buffer.concat(chunks, totalBytes);
    },

    putObject(
      objectKey: string,
      buffer: Buffer,
      metadata: Record<string, string>,
    ) {
      return minioClient.putObject(
        bucket,
        objectKey,
        buffer,
        buffer.length,
        metadata,
      );
    },

    copyObject(
      sourceObjectKey: string,
      destinationObjectKey: string,
      { matchEtag }: { matchEtag?: string } = {},
    ) {
      const source = new CopySourceOptions({
        Bucket: bucket,
        Object: sourceObjectKey,
        ...(matchEtag ? { MatchETag: matchEtag } : {}),
      });
      const destination = new CopyDestinationOptions({
        Bucket: bucket,
        Object: destinationObjectKey,
      });
      return minioClient.copyObject(source, destination);
    },

    removeObject(objectKey: string) {
      return minioClient.removeObject(bucket, objectKey);
    },
  };
}

function descriptorNeedsDimensionUpdate(
  descriptor: LegacyAttachmentDescriptor | null,
  width: number,
  height: number,
): descriptor is LegacyAttachmentDescriptor {
  if (!descriptor) return false;
  const hasStoredDimension =
    Number.isFinite(descriptor.width) ||
    Number.isFinite(descriptor.height);
  return hasStoredDimension &&
    (descriptor.width !== width || descriptor.height !== height);
}

export function createDescriptorUpdater({
  scylla,
  cassandra,
}: {
  scylla: CassandraClient;
  cassandra: CassandraDriverModule;
}): LegacyMigrationDependencies['updateDescriptorDimensions'] {
  return async function updateDescriptorDimensions(
    row: LegacyAttachmentRow,
    references: LegacyDescriptorReference[],
    width: number,
    height: number,
  ) {
    const updatesByMessage = new Map<string, DescriptorUpdate>();

    for (const reference of references) {
      const messageRecord = reference.messageRecord;
      const key = `${messageRecord.storageConversationId}:${messageRecord.messageId}`;
      let update = updatesByMessage.get(key);
      if (!update) {
        update = {
          messageRecord,
          originalAttachments: [...messageRecord.attachments],
          nextAttachments: [...messageRecord.attachments],
          updatedCount: 0,
        };
        updatesByMessage.set(key, update);
      }

      const descriptor = parseLegacyAttachmentDescriptor(
        update.nextAttachments[reference.index],
      );
      if (
        getLegacyDescriptorAttachmentId(descriptor) !== String(row.id).toLowerCase() ||
        !descriptorNeedsDimensionUpdate(descriptor, width, height)
      ) {
        continue;
      }

      descriptor.width = width;
      descriptor.height = height;
      update.nextAttachments[reference.index] = JSON.stringify(descriptor);
      update.updatedCount += 1;
    }

    const pendingUpdates = [...updatesByMessage.values()]
      .filter((update) => update.updatedCount > 0);
    if (pendingUpdates.length === 0) {
      return { updatedCount: 0 };
    }

    const statements = pendingUpdates.map((update) => ({
      query: `UPDATE messages
              SET attachments = ?
              WHERE conversation_id = ?
                AND message_id = ?
              IF attachments = ?`,
      params: [
        update.nextAttachments,
        cassandra.types.Uuid.fromString(update.messageRecord.storageConversationId),
        cassandra.types.TimeUuid.fromString(update.messageRecord.messageId),
        update.originalAttachments,
      ],
    }));
    const result = statements.length === 1
      ? await scylla.execute(
          statements[0].query,
          statements[0].params,
          { prepare: true },
        )
      : await scylla.batch(statements, { prepare: true });
    const applied = result.rows?.[0]?.['[applied]'];

    if (applied === false) {
      const error = new Error(
        'Attachment descriptor changed concurrently; no dimensions were overwritten',
      );
      setErrorCode(error, 'LEGACY_IMAGE_DESCRIPTOR_CONFLICT');
      throw error;
    }

    pendingUpdates.forEach((update) => {
      update.messageRecord.attachments = update.nextAttachments;
    });
    return {
      updatedCount: pendingUpdates.reduce(
        (total, update) => total + update.updatedCount,
        0,
      ),
    };
  };
}

function createDeliveryVerifier({
  attachSignedAttachmentUrls,
}: {
  attachSignedAttachmentUrls: AttachSignedAttachmentUrls;
}): NonNullable<LegacyMigrationDependencies['verifyDelivery']> {
  return async function verifyDelivery(
    row: LegacyAttachmentRow,
    reference: LegacyDescriptorReference,
  ) {
    const rawAttachment = reference?.messageRecord?.attachments?.[reference.index];
    if (typeof rawAttachment !== 'string') {
      const error = new Error('Attachment descriptor is unavailable for delivery verification');
      setErrorCode(error, 'LEGACY_IMAGE_DESCRIPTOR_MISSING');
      throw error;
    }

    const [deliveredMessage] = await attachSignedAttachmentUrls(
      [{ attachments: [rawAttachment] }],
      String(row.conversation_id),
    );
    const delivered = parseLegacyAttachmentDescriptor(
      deliveredMessage?.attachments?.[0],
    );
    const originalUrl = delivered?.url;
    const displayUrl = delivered?.display_url;

    if (
      delivered?.inline !== true ||
      typeof originalUrl !== 'string' ||
      !/^https?:\/\//i.test(originalUrl) ||
      typeof displayUrl !== 'string' ||
      !/^https?:\/\//i.test(displayUrl) ||
      originalUrl === displayUrl
    ) {
      const error = new Error('Migrated attachment did not receive trusted original and VMD delivery');
      setErrorCode(error, 'LEGACY_IMAGE_DELIVERY_VERIFICATION_FAILED');
      throw error;
    }
  };
}

async function writeReportRecord(
  fileHandle: FileHandle,
  record: LegacyMigrationRecord,
): Promise<void> {
  await fileHandle.write(`${JSON.stringify(record)}\n`);
}

async function main(): Promise<void> {
  const options = parseLegacyImageMigrationArgs(process.argv.slice(2));
  options.attachmentIds = options.attachmentIdsFile
    ? await readApprovedAttachmentIds(options.attachmentIdsFile)
    : null;
  if (options.attachmentIds && options.limit < options.attachmentIds.length) {
    throw new Error(
      `--limit must be at least the ${options.attachmentIds.length} allowlisted attachments`,
    );
  }
  await mkdir(path.dirname(options.reportPath), { recursive: true });
  let reportFile: FileHandle | null = null;
  let pool: Pool | null = null;
  let scylla: CassandraClient | null = null;

  try {
    const openedReportFile = await open(options.reportPath, 'wx');
    reportFile = openedReportFile;
    const [
      databaseModule,
      scyllaModule,
      minioModule,
      sanitizerClientModule,
      sanitizerProtocolModule,
      messageConversationModule,
      attachmentDeliveryModule,
    ] = await Promise.all([
      import('../../server/db.js'),
      import('../../server/scylla.js'),
      import('../../server/minio.js'),
      import('../../server/attachmentSanitizer/client.js'),
      import('../../server/attachmentSanitizer/ipcProtocol.js'),
      import('../../server/utils/messageConversation.js'),
      import('../../server/utils/attachmentDelivery.js'),
    ]);
    pool = databaseModule.pool;
    scylla = scyllaModule.default;
    const { cassandra } = scyllaModule;
    const { minioClient, ATTACH_BUCKET } = minioModule;
    const { sanitizeChatAttachmentImageInWorker } = sanitizerClientModule;
    const { getAttachmentSanitizerSocketPath } = sanitizerProtocolModule;
    const { resolveMessageStorageConversation } = messageConversationModule;
    const { attachSignedAttachmentUrls } = attachmentDeliveryModule;

    const socketPath = getAttachmentSanitizerSocketPath();
    await access(socketPath);
    const rows = await listAttachmentObjects(pool, ATTACH_BUCKET, options);
    assertExactAttachmentSelection(rows, options.attachmentIds);
    const findDescriptorReferences = createDescriptorResolver({
      pool,
      scylla,
      cassandra,
      resolveMessageStorageConversation,
      selectedRows: rows,
    });
    const dependencies = {
      findDescriptorReferences,
      objectStore: createObjectStore(minioClient, ATTACH_BUCKET),
      sanitizeImage: sanitizeChatAttachmentImageInWorker,
      updateDescriptorDimensions: createDescriptorUpdater({ scylla, cassandra }),
      verifyDelivery: createDeliveryVerifier({ attachSignedAttachmentUrls }),
    };

    console.log('[LEGACY_IMAGE_MIGRATION] started', {
      mode: options.apply ? 'apply' : 'dry-run',
      selected_rows: rows.length,
      concurrency: 1,
      source_byte_limit: MAX_CHAT_ATTACHMENT_BYTES,
      report: options.reportPath,
    });

    const records = await runLegacyImageMigration(rows, {
      apply: options.apply,
      dependencies,
      onRecord: async (record) => {
        await writeReportRecord(openedReportFile, record);
        console.log('[LEGACY_IMAGE_MIGRATION] candidate completed', {
          attachment_id: record.attachment_id,
          status: record.status,
        });
      },
    });
    const summary = summarizeLegacyImageMigration(records);
    console.log('[LEGACY_IMAGE_MIGRATION] completed', {
      ...summary,
      report: options.reportPath,
      next_resume_cursor: rows.at(-1)?.id || null,
    });
  } finally {
    await reportFile?.close();
    await Promise.allSettled([
      pool?.end(),
      scylla?.shutdown(),
    ]);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[LEGACY_IMAGE_MIGRATION] fatal', {
      code: getErrorCode(error, 'LEGACY_IMAGE_MIGRATION_FATAL'),
      message: error instanceof Error ? error.message : String(error || ''),
    });
    process.exitCode = 1;
  });
}
