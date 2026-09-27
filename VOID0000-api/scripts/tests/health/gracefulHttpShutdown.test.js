import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const helperUrl = new URL('../../../server/health/gracefulHttpShutdown.ts', import.meta.url).href;

async function runShutdown({ keepHandle, failHook, ipc = false }) {
  const source = `
    import { createServer } from 'node:http';
    import { installGracefulHttpShutdown } from ${JSON.stringify(helperUrl)};
    const server = createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', () => console.log('READY'));
    ${keepHandle ? 'setInterval(() => {}, 1000);' : ''}
    installGracefulHttpShutdown(server, {
      service: 'Isolated shutdown test',
      hooks: [${failHook ? "() => Promise.reject(new Error('test hook failure'))" : 'async () => {}'}],
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: new URL('../../..', import.meta.url),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { output += data; });
  }
  try {
    const ready = Promise.race([
      new Promise((resolve) => child.stdout.on('data', (data) => {
        if (data.toString().includes('READY')) resolve(true);
      })),
      delay(5_000).then(() => false),
    ]);
    assert.equal(await ready, true, output);
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.once('close', resolve));
    const started = performance.now();
    assert.equal(child.kill('SIGTERM'), true);
    const result = await Promise.race([exited, delay(1_500).then(() => null)]);
    const elapsedMs = performance.now() - started;
    assert.ok(result, `child remained alive: ${output}`);
    await closed;
    return { ...result, elapsedMs, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('completed hooks permit natural process exit', async () => {
  const result = await runShutdown({ keepHandle: false, failHook: false });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.elapsedMs < 500, `natural exit took ${result.elapsedMs}ms`);
  assert.doesNotMatch(result.output, /remained alive after shutdown cleanup/);
});

test('post-cleanup deadline terminates a process with a forgotten live handle', async () => {
  const result = await runShutdown({ keepHandle: true, failHook: false });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.elapsedMs >= 400 && result.elapsedMs < 1_500);
  assert.match(result.output, /remained alive after shutdown cleanup/);
});

test('post-cleanup deadline preserves a rejected hook exit status', async () => {
  const result = await runShutdown({ keepHandle: true, failHook: true });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.output, /shutdown hook failed/);
  assert.match(result.output, /remained alive after shutdown cleanup/);
});

test('IPC disconnect preserves a rejected hook exit status without the fallback', async () => {
  const result = await runShutdown({ keepHandle: false, failHook: true, ipc: true });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.output, /shutdown hook failed/);
  assert.doesNotMatch(result.output, /remained alive after shutdown cleanup|IPC disconnect failed/);
});
