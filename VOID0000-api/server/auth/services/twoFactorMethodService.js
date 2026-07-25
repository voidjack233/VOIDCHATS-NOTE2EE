const PRIMARY_METHODS = Object.freeze(['totp', 'email']);
const LOGIN_METHODS = Object.freeze([...PRIMARY_METHODS, 'backup']);

export const BACKUP_CODE_LOGIN_POLICY = 'unused-code-required';

export function normalizeTwoFactorMethod(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LOGIN_METHODS.includes(normalized) ? normalized : null;
}

export function buildAllowedTwoFactorMethods(enabledMethods, backupCodesAvailable = false) {
  const enabled = new Set(
    Array.isArray(enabledMethods)
      ? enabledMethods.map(normalizeTwoFactorMethod).filter(Boolean)
      : [],
  );
  const methods = PRIMARY_METHODS.filter((method) => enabled.has(method));
  if (backupCodesAvailable && methods.length > 0) {
    methods.push('backup');
  }
  return Object.freeze(methods);
}

export function isTwoFactorMethodAllowed(session, method) {
  const normalizedMethod = normalizeTwoFactorMethod(method);
  return Boolean(
    normalizedMethod &&
    Array.isArray(session?.allowedMethods) &&
    session.allowedMethods.includes(normalizedMethod),
  );
}

export async function loadAllowedTwoFactorMethods(queryable, userId) {
  const enabledResult = await queryable.query(
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

  const backupResult = await queryable.query(
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

export async function isTwoFactorMethodCurrentlyAvailable(queryable, userId, method) {
  const normalizedMethod = normalizeTwoFactorMethod(method);
  if (!normalizedMethod) return false;

  if (normalizedMethod === 'backup') {
    const result = await queryable.query(
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

  const result = await queryable.query(
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

export async function isTwoFactorMethodAuthorized(queryable, session, method) {
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
