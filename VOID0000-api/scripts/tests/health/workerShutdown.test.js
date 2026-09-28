import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { waitFor } from './scyllaShutdownFixture.js';
import { assertWorkerNaturalExit, createWorkerShutdownFixture, terminateWorker, workerTrace } from './workerShutdownFixture.js';

function evidence(name, output, report) {
  const directory = process.env.WORKER_SHUTDOWN_EVIDENCE_DIR;
  if (!directory) return;
  writeFileSync(join(directory, `${name}.log`), output);
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(report, null, 2));
}
function assertSocketsRemoved(fixture) {
  for (const key of ['ATTACHMENT_SANITIZER_SOCKET_PATH', 'VMD_TRANSFORM_SOCKET_PATH']) {
    assert.equal(existsSync(fixture.env[key]), false, `${key} was not removed`);
  }
}

test('real worker drains its owners and exits naturally after image sanitization', { timeout: 60_000 }, async (t) => {
  const fixture = await createWorkerShutdownFixture(t);
  const service = await fixture.startDirect();
  const sanitized = await fixture.sanitize();
  const result = await terminateWorker(service);
  assertSocketsRemoved(fixture);
  evidence('natural', service.logs(), { ...result, sanitized });
  t.diagnostic(JSON.stringify(result));
});

test('SIGTERM finishes an active avatar job before exit; replacement completes waiting work once', { timeout: 60_000 }, async (t) => {
  const fixture = await createWorkerShutdownFixture(t);
  const service = await fixture.startDirect();
  const transaction = await fixture.pool.connect();
  let locked = true;
  fixture.cleanup.push(async () => { if (locked) { await transaction.query('ROLLBACK'); transaction.release(); } });
  await transaction.query('BEGIN');
  await transaction.query('SELECT id FROM user_profiles WHERE id=$1 FOR UPDATE', [fixture.profileId]);
  const job = await fixture.enqueue();
  // Real Sharp and MinIO writes have finished; the real PG update is waiting
  // on our isolated row lock. This deterministically tests a partially finished job.
  await waitFor(async () => {
    const result = await fixture.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'UPDATE user_profiles%' AND wait_event_type='Lock'");
    return result.rows.length === 1 && workerTrace(service.logs()).some((event) => event.event === 'job-started' && event.jobId === job.id);
  });
  assert.equal((await fixture.listAvatars()).length, 1);
  assert.equal(await job.getState(), 'active');
  assert.equal(service.child.kill('SIGTERM'), true);
  await waitFor(() => workerTrace(service.logs()).some((event) => event.event === 'worker-close-start' && event.activeJobs.includes(job.id)));
  const waiting = await fixture.enqueue();
  await delay(200);
  assert.equal(service.child.exitCode, null, service.logs());
  assert.equal(await job.getState(), 'active');
  assert.equal(await waiting.getState(), 'waiting');
  await transaction.query('COMMIT'); transaction.release(); locked = false;
  const result = await Promise.race([service.exited, delay(8_000).then(() => null)]);
  assert.deepEqual(result, { code: 0, signal: null }, service.logs());
  await service.closed;
  const natural = assertWorkerNaturalExit(service.logs(), service.pid);
  assertSocketsRemoved(fixture);
  const first = await fixture.verifyJob(job);
  assert.deepEqual(await fixture.listAvatars(), [first.filename]);
  const finishedOn = (await fixture.queue.getJob(job.id)).finishedOn;
  const replacement = await fixture.startDirect();
  await fixture.sanitize();
  const second = await fixture.verifyJob(waiting);
  assert.notEqual(first.filename, second.filename);
  assert.equal((await fixture.queue.getJob(job.id)).finishedOn, finishedOn);
  assert.equal((await fixture.queue.getJob(job.id)).attemptsMade, 1);
  assert.deepEqual((await fixture.listAvatars()).sort(), [first.filename, second.filename].sort());
  assert.ok(!workerTrace(service.logs()).some((event) => event.event === 'job-started' && event.jobId === waiting.id));
  const replacementExit = await terminateWorker(replacement);
  evidence('active-job', service.logs() + '\n' + replacement.logs(), { ...natural, first, second, replacement: replacementExit });
  t.diagnostic(JSON.stringify({ ...natural, first, second, replacement: replacementExit }));
});

test('private PM2 replaces a naturally terminated worker and processes an image job', { timeout: 90_000 }, async (t) => {
  const fixture = await createWorkerShutdownFixture(t);
  const service = await fixture.startPm2();
  await fixture.sanitize();
  const before = await service.state();
  const signaledAt = Date.now();
  process.kill(before.pid, 'SIGTERM');
  const replacement = await waitFor(async () => {
    const state = await service.state();
    return state.pid && state.pid !== before.pid && state.pm2_env.status === 'online' ? state : false;
  });
  await service.ready(service.logs, replacement.pid);
  const recoveryMs = Date.now() - signaledAt;
  const oldExit = assertWorkerNaturalExit(service.logs(), before.pid);
  assert.equal(replacement.pm2_env.restart_time, before.pm2_env.restart_time + 1);
  assert.equal(existsSync(`/proc/${before.pid}`), false);
  const sanitized = await fixture.sanitize();
  const imageJob = await fixture.verifyJob(await fixture.enqueue());
  const report = { ...oldExit, oldPid: before.pid, newPid: replacement.pid,
    restartsBefore: before.pm2_env.restart_time, restartsAfter: replacement.pm2_env.restart_time, recoveryMs,
    sanitized, imageJob };
  // Delete only the private application for cleanup. Acceptance above used
  // direct SIGTERM; no supervisor restart command was issued.
  await service.cli(['delete', 'isolated-worker']);
  assertWorkerNaturalExit(service.logs(), replacement.pid);
  evidence('pm2', service.logs(), report);
  t.diagnostic(JSON.stringify(report));
});

test('worker cleanup rejection preserves a nonzero exit while closing other owners', { timeout: 60_000 }, async (t) => {
  const fixture = await createWorkerShutdownFixture(t, { failPgEnd: true });
  const service = await fixture.startDirect();
  await fixture.sanitize();
  service.child.kill('SIGTERM');
  const result = await Promise.race([service.exited, delay(8_000).then(() => null)]);
  assert.deepEqual(result, { code: 1, signal: null }, service.logs());
  await service.closed;
  assert.match(service.logs(), /Worker shutdown failed: Error: Injected PG close rejection/);
  assert.doesNotMatch(service.logs(), /Worker shutdown timed out/);
  const events = workerTrace(service.logs());
  assert.ok(!events.some((event) => event.event === 'explicit-exit'));
  const natural = events.findLast((event) => event.event === 'natural-before-exit');
  assert.equal(natural.code, 1);
  assert.ok(natural.state.redis.every((client) => client.socket.destroyed));
  assert.equal(natural.state.postgres[0].ended, true);
  assertSocketsRemoved(fixture);
  evidence('cleanup-failure', service.logs(), { pid: service.pid, code: 1, natural: true, fallbackFired: false });
});
