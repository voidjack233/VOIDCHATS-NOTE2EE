import crypto from 'crypto';
import argon2 from 'argon2';
import { pool } from '../../db.js';
import {
  getTotpEncryptionKey,
  getTwoFactorCodeSecret,
} from '../config/authSecrets.js';

export function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = getTotpEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedText) {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = getTotpEncryptionKey();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function generateSetupEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

export function hashSetupEmailCode(userId, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:setup_email:${String(code).trim()}`)
    .digest('hex');
}

export function getActionEmailKey(userId, action) {
  return `auth:2fa:action-email:${userId}:${action}`;
}

export function getActionEmailRateKey(userId, action) {
  return `auth:2fa:action-email-rate:${userId}:${action}`;
}

export function generateActionEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

export function hashActionEmailCode(userId, action, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:${action}:${String(code).trim()}`)
    .digest('hex');
}

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function findMatchingBackupCodeId(rows, code) {
  const normalizedCode = code.trim().toUpperCase();
  for (const row of rows) {
    if (await argon2.verify(row.code_hash, normalizedCode)) {
      return row.id;
    }
  }
  return null;
}

export async function consumeBackupCode(queryable, backupCodeId, userId) {
  const result = await queryable.query(
    `UPDATE user_2fa_backup_codes
     SET is_used = true,
         used_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND is_used = false
     RETURNING id`,
    [backupCodeId, userId],
  );
  return result.rows.length === 1;
}

export async function generateBackupCodes(userId) {
  await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);

  const codes = [];
  const plainCodes = [];

  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    plainCodes.push(code);

    const codeHash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: 2 ** 14,
      timeCost: 2,
      parallelism: 1,
    });

    codes.push({ userId, codeHash });
  }

  for (const { userId: uid, codeHash } of codes) {
    await pool.query(
      `INSERT INTO user_2fa_backup_codes (user_id, code_hash, created_at) VALUES ($1, $2, NOW())`,
      [uid, codeHash],
    );
  }

  return plainCodes;
}
