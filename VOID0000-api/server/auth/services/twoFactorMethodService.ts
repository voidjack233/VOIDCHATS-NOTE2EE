import type { QueryResultRow } from 'pg';

import type { DatabaseQueryable } from '../../db/types.js';
import type {
  PendingTwoFactorSession,
  PrimaryTwoFactorMethod,
  TwoFactorMethod,
} from '../types.js';

const PRIMARY_METHODS: readonly PrimaryTwoFactorMethod[] = Object.freeze([
  'totp',
  'email',
]);
const LOGIN_METHODS: readonly TwoFactorMethod[] = Object.freeze([
  ...PRIMARY_METHODS,
  'backup',
]);

export const BACKUP_CODE_LOGIN_POLICY = 'unused-code-required';

export function normalizeTwoFactorMethod(value: unknown): TwoFactorMethod | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LOGIN_METHODS.find((method) => method === normalized) ?? null;
}

export function buildAllowedTwoFactorMethods(
  enabledMethods: unknown,
  backupCodesAvailable: boolean = false,
): readonly TwoFactorMethod[] {
  const enabled = new Set(
    Array.isArray(enabledMethods)
      ? enabledMethods.map(normalizeTwoFactorMethod).filter(Boolean)
      : [],
  );
  const methods: TwoFactorMethod[] = PRIMARY_METHODS.filter((method) =>
    enabled.has(method),
  );
  if (backupCodesAvailable && methods.length > 0) {
    methods.push('backup');
  }
  return Object.freeze(methods);
}

export function isTwoFactorMethodAllowed(
  session: Pick<PendingTwoFactorSession, 'allowedMethods'> | null | undefined,
  method: unknown,
): boolean {
  const normalizedMethod = normalizeTwoFactorMethod(method);
  return Boolean(
    normalizedMethod &&
    Array.isArray(session?.allowedMethods) &&
    session.allowedMethods.includes(normalizedMethod),
  );
}

interface MethodRow extends QueryResultRow {
  method: string;
}

interface AvailabilityRow extends QueryResultRow {
  available: boolean;
}

export async function loadAllowedTwoFactorMethods(
  queryable: DatabaseQueryable,
  userId: string,
): Promise<readonly TwoFactorMethod[]> {
  const enabledResult = await queryable.query<MethodRow>(
    `SELECT method
     FROM user_2fa
     WHERE user_id = $1
       AND is_enabled = true
       AND method IN ('totp', 'email')`,
    [userId],
  );
  const enabledMethods = buildAllowedTwoFactorMethods(
    enabledResult.rows.map((row) => row.method),
  );
  if (enabledMethods.length === 0) return enabledMethods;

  const backupResult = await queryable.query<AvailabilityRow>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_2fa_backup_codes
       WHERE user_id = $1
         AND is_used = false
     ) AS available`,
    [userId],
  );

  return buildAllowedTwoFactorMethods(
    enabledMethods,
    backupResult.rows[0]?.available === true,
  );
}

export async function isTwoFactorMethodCurrentlyAvailable(
  queryable: DatabaseQueryable,
  userId: string,
  method: unknown,
): Promise<boolean> {
  const normalizedMethod = normalizeTwoFactorMethod(method);
  if (!normalizedMethod) return false;

  if (normalizedMethod === 'backup') {
    const result = await queryable.query<AvailabilityRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM user_2fa_backup_codes
         WHERE user_id = $1
           AND is_used = false
       ) AS available`,
      [userId],
    );
    return result.rows[0]?.available === true;
  }

  const result = await queryable.query<AvailabilityRow>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_2fa
       WHERE user_id = $1
         AND method = $2
         AND is_enabled = true
     ) AS available`,
    [userId, normalizedMethod],
  );
  return result.rows[0]?.available === true;
}

export async function isTwoFactorMethodAuthorized(
  queryable: DatabaseQueryable,
  session: PendingTwoFactorSession,
  method: unknown,
): Promise<boolean> {
  const normalizedMethod = normalizeTwoFactorMethod(method);
  if (!normalizedMethod || !isTwoFactorMethodAllowed(session, normalizedMethod)) {
    return false;
  }
  return isTwoFactorMethodCurrentlyAvailable(
    queryable,
    session.userId,
    normalizedMethod,
  );
}
