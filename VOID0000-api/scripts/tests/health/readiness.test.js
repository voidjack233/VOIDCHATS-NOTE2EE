import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessHandler } from '../../../server/health/readiness.js';

async function runReadiness(check, timeoutMs = 25) {
  const response = {
    code: 0,
    body: undefined,
    status(code) { this.code = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
  };
  await createReadinessHandler({ service: 'test', checks: { minio: check }, timeoutMs })({}, response, () => {});
  return { status: response.code, dependency: response.body.dependencies.minio };
}

test('required MinIO bucket existence controls readiness', async () => {
  const exists = await runReadiness(async () => true);
  assert.equal(exists.status, 200);
  assert.equal(exists.dependency.ok, true);

  const missing = await runReadiness(async () => false);
  assert.equal(missing.status, 503);
  assert.equal(missing.dependency.ok, false);
});

test('readiness still fails closed on errors and timeouts', async () => {
  const errored = await runReadiness(async () => { throw new Error('unavailable'); });
  assert.equal(errored.status, 503);
  assert.equal(errored.dependency.ok, false);
  assert.match(errored.dependency.error, /unavailable/);

  const timedOut = await runReadiness(() => new Promise(() => {}), 5);
  assert.equal(timedOut.status, 503);
  assert.equal(timedOut.dependency.ok, false);
  assert.match(timedOut.dependency.error, /Timed out/);
});

test('resolved nonboolean dependency results retain their existing success semantics', async () => {
  for (const value of [0, '', null, { rows: [] }]) {
    const result = await runReadiness(async () => value);
    assert.equal(result.status, 200);
    assert.equal(result.dependency.ok, true);
  }
});
