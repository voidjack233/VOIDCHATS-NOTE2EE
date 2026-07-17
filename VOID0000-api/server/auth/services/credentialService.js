import argon2 from 'argon2';

export const PASSWORD_HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 2 ** 16,
  timeCost: 3,
  parallelism: 1,
});

export function verifyPassword(passwordHash, password) {
  return argon2.verify(passwordHash, password);
}

export function hashPassword(password) {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

export async function rehashPasswordIfNeeded(queryable, userId, passwordHash, password) {
  const needsRehash = await argon2.needsRehash(passwordHash, PASSWORD_HASH_OPTIONS);
  if (!needsRehash) {
    return false;
  }

  const newHash = await hashPassword(password);
  await queryable.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [newHash, userId],
  );
  return true;
}
