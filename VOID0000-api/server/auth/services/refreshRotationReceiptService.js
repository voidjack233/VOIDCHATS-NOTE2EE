import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import valkey from '../../valkey.js';
import { getRefreshSecret } from '../config/authSecrets.js';

export const REFRESH_PREDECESSOR_GRACE_SECONDS = 5;

const RECEIPT_VERSION = 1;
const RECEIPT_KEY_PREFIX = 'auth:refresh-rotation-receipt:';
const RECEIPT_OPERATION_TIMEOUT_MS = 250;
const RECEIPT_ENCRYPTION_CONTEXT = 'void-auth-refresh-rotation-receipt:v1';

function getReceiptKey(consumedTokenHash) {
  return `${RECEIPT_KEY_PREFIX}${consumedTokenHash}`;
}

function getReceiptEncryptionKey() {
  return createHmac('sha256', getRefreshSecret())
    .update(RECEIPT_ENCRYPTION_CONTEXT)
    .digest();
}

function getReceiptAuthenticatedData({
  userId,
  deviceId,
  consumedTokenHash,
  consumedJti,
  replacementTokenHash,
  replacementJti,
  expiresAt,
}) {
  return Buffer.from([
    RECEIPT_VERSION,
    userId,
    deviceId,
    consumedTokenHash,
    consumedJti,
    replacementTokenHash,
    replacementJti,
    expiresAt,
  ].join('\n'), 'utf8');
}

function settleWithin(operation, fallbackValue) {
  // Valkey availability must never hold the PostgreSQL rotation transaction open.
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(fallbackValue), RECEIPT_OPERATION_TIMEOUT_MS);

    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(fallbackValue);
      },
    );
  });
}

function encryptReplacementToken(replacementRefreshToken, metadata) {
  // The winner token must be replayable without storing it as plaintext in Valkey.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getReceiptEncryptionKey(), iv);
  cipher.setAAD(getReceiptAuthenticatedData(metadata));

  const ciphertext = Buffer.concat([
    cipher.update(replacementRefreshToken, 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptReplacementToken(receipt, metadata) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getReceiptEncryptionKey(),
    Buffer.from(receipt.iv, 'base64'),
  );
  decipher.setAAD(getReceiptAuthenticatedData(metadata));
  decipher.setAuthTag(Buffer.from(receipt.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(receipt.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function storeRefreshRotationReceipt({
  consumedTokenHash,
  consumedJti,
  userId,
  deviceId,
  replacementTokenHash,
  replacementJti,
  replacementRefreshToken,
  ttlSeconds = REFRESH_PREDECESSOR_GRACE_SECONDS,
}) {
  try {
    const boundedTtlSeconds = Math.max(
      1,
      Math.min(REFRESH_PREDECESSOR_GRACE_SECONDS, Math.floor(ttlSeconds)),
    );
    const expiresAt = Date.now() + (boundedTtlSeconds * 1000);
    const metadata = {
      userId: String(userId),
      deviceId: String(deviceId),
      consumedTokenHash: String(consumedTokenHash),
      consumedJti: String(consumedJti),
      replacementTokenHash: String(replacementTokenHash),
      replacementJti: String(replacementJti),
      expiresAt,
    };
    const encryptedToken = encryptReplacementToken(replacementRefreshToken, metadata);
    const receipt = {
      version: RECEIPT_VERSION,
      userId: metadata.userId,
      deviceId: metadata.deviceId,
      consumedJti: metadata.consumedJti,
      replacementTokenHash: metadata.replacementTokenHash,
      replacementJti: metadata.replacementJti,
      expiresAt,
      ...encryptedToken,
    };

    const result = await settleWithin(
      valkey.set(
        getReceiptKey(metadata.consumedTokenHash),
        JSON.stringify(receipt),
        'PXAT',
        expiresAt,
        'NX',
      ),
      null,
    );

    return result === 'OK';
  } catch {
    return false;
  }
}

export async function getRefreshRotationReceipt({
  consumedTokenHash,
  consumedJti,
  userId,
  deviceId,
}) {
  try {
    const rawReceipt = await settleWithin(
      valkey.get(getReceiptKey(consumedTokenHash)),
      null,
    );
    if (!rawReceipt) return null;

    const receipt = JSON.parse(rawReceipt);
    const expectedUserId = String(userId);
    const expectedDeviceId = String(deviceId);
    const expectedConsumedJti = String(consumedJti);

    if (
      receipt.version !== RECEIPT_VERSION ||
      receipt.userId !== expectedUserId ||
      receipt.deviceId !== expectedDeviceId ||
      receipt.consumedJti !== expectedConsumedJti ||
      !Number.isFinite(receipt.expiresAt) ||
      receipt.expiresAt <= Date.now() ||
      typeof receipt.replacementTokenHash !== 'string' ||
      typeof receipt.replacementJti !== 'string' ||
      typeof receipt.iv !== 'string' ||
      typeof receipt.ciphertext !== 'string' ||
      typeof receipt.authTag !== 'string'
    ) {
      return null;
    }

    const metadata = {
      userId: expectedUserId,
      deviceId: expectedDeviceId,
      consumedTokenHash: String(consumedTokenHash),
      consumedJti: expectedConsumedJti,
      replacementTokenHash: receipt.replacementTokenHash,
      replacementJti: receipt.replacementJti,
      expiresAt: receipt.expiresAt,
    };

    return {
      replacementRefreshToken: decryptReplacementToken(receipt, metadata),
      replacementTokenHash: receipt.replacementTokenHash,
      replacementJti: receipt.replacementJti,
    };
  } catch {
    return null;
  }
}

export async function deleteRefreshRotationReceipt(consumedTokenHash) {
  if (!consumedTokenHash) return false;

  try {
    const deleted = await settleWithin(
      valkey.del(getReceiptKey(consumedTokenHash)),
      0,
    );
    return deleted > 0;
  } catch {
    return false;
  }
}
