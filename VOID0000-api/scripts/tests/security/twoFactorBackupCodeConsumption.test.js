import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeBackupCode,
} from '../../../server/auth/services/twoFactorService.js';

test('a backup code conditional update permits exactly one concurrent authentication', async () => {
  let isUsed = false;
  let loginSessionCount = 0;
  const statements = [];
  const queryable = {
    async query(sql, parameters) {
      statements.push({ sql, parameters });
      await new Promise((resolve) => setImmediate(resolve));
      if (isUsed) return { rows: [] };
      isUsed = true;
      return { rows: [{ id: parameters[0] }] };
    },
  };

  const authenticate = async () => {
    const consumed = await consumeBackupCode(
      queryable,
      'backup-code-id',
      'test-user',
    );
    if (consumed) loginSessionCount += 1;
    return consumed;
  };

  const results = await Promise.all([authenticate(), authenticate()]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(loginSessionCount, 1);
  assert.equal(isUsed, true);
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.match(statement.sql, /WHERE id = \$1/);
    assert.match(statement.sql, /user_id = \$2/);
    assert.match(statement.sql, /is_used = false/);
    assert.match(statement.sql, /RETURNING id/);
    assert.deepEqual(statement.parameters, ['backup-code-id', 'test-user']);
  }
});
