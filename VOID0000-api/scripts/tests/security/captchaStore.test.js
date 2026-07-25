import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import valkey from '../../../server/valkey.js';
import {
  consumeCaptchaChallenge,
  deleteCaptchaChallenge,
  getCaptchaChallengeTtl,
  saveCaptchaChallenge,
} from '../../../server/utils/captchaStore.js';

after(async () => {
  await valkey.quit();
});

function createCaptchaId() {
  return `test-${crypto.randomUUID()}`;
}

test('concurrent CAPTCHA failures atomically exhaust the challenge', async (t) => {
  const captchaId = createCaptchaId();
  t.after(() => deleteCaptchaChallenge(captchaId));
  await saveCaptchaChallenge(captchaId, 'CORRECT');

  const results = await Promise.all(Array.from({ length: 20 }, () => (
    consumeCaptchaChallenge(captchaId, 'WRONG')
  )));
  const countedAttempts = results
    .filter((result) => result.status === 'wrong' || result.status === 'exhausted')
    .map((result) => result.attempts)
    .sort((left, right) => left - right);

  assert.deepEqual(countedAttempts, [1, 2, 3]);
  assert.equal(results.filter((result) => result.status === 'exhausted').length, 1);
  assert.equal(results.filter((result) => result.status === 'missing').length, 17);
});

test('two concurrent correct CAPTCHA submissions cannot both succeed', async (t) => {
  const captchaId = createCaptchaId();
  t.after(() => deleteCaptchaChallenge(captchaId));
  await saveCaptchaChallenge(captchaId, 'CORRECT');

  const results = await Promise.all([
    consumeCaptchaChallenge(captchaId, 'CORRECT'),
    consumeCaptchaChallenge(captchaId, 'CORRECT'),
  ]);

  assert.equal(results.filter((result) => result.status === 'success').length, 1);
  assert.equal(results.filter((result) => result.status === 'missing').length, 1);
});

test('failed CAPTCHA attempts preserve the original expiry window', async (t) => {
  const captchaId = createCaptchaId();
  t.after(() => deleteCaptchaChallenge(captchaId));
  await saveCaptchaChallenge(captchaId, 'CORRECT');
  const initialTtl = await getCaptchaChallengeTtl(captchaId);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await consumeCaptchaChallenge(captchaId, 'WRONG');
  const finalTtl = await getCaptchaChallengeTtl(captchaId);

  assert.ok(initialTtl > 0);
  assert.ok(finalTtl > 0);
  assert.ok(finalTtl < initialTtl);
});

test('CAPTCHA backend failures reject instead of accepting the answer', async () => {
  const failingClient = {
    async eval() {
      throw new Error('valkey unavailable');
    },
  };

  await assert.rejects(
    consumeCaptchaChallenge(createCaptchaId(), 'CORRECT', failingClient),
    /valkey unavailable/,
  );
});
