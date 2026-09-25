// Benchmark-only preload for the real compiled message-server entrypoint.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

if (!process.send || !process.env.VOID_HISTORY_BENCH_ROOT) throw new Error('Benchmark IPC/root required');
const moduleAt = file => import(pathToFileURL(resolve(process.env.VOID_HISTORY_BENCH_ROOT, 'dist/server', file)));
const { pool } = await moduleAt('db.js');
const { minioClient, cdnMinioClient } = await moduleAt('minio.js');
const { historyMetrics } = await moduleAt('health/historyMetrics.js');
const { default: sentinel } = await moduleAt('sentinel/index.js');
// The SDK normally stores an immutable ESM namespace here. Instrument a copy,
// retaining the same transport functions rather than replacing network behavior.
cdnMinioClient.transport = { ...cdnMinioClient.transport };
let measurement = null, profiler = null, sampling = null, loop = null;
const originalConnect = pool.connect.bind(pool);
pool.connect = function (callback) {
  const current = measurement, started = performance.now();
  const record = () => { if (current) current.pgWaitMs.push(performance.now() - started); };
  const result = callback
    ? originalConnect((...args) => { record(); callback(...args); })
    : originalConnect().then(client => { record(); return client; });
  if (current) current.pgWaitingMax = Math.max(current.pgWaitingMax, pool.waitingCount);
  return result;
};
for (const [object, method, key] of [
  [minioClient, 'statObject', 'statCalls'],
  [cdnMinioClient, 'presignedGetObject', 'originalCalls'],
  [cdnMinioClient.transport, 'request', 'transportCalls'],
]) {
  const original = object[method];
  object[method] = function (...args) {
    if (measurement) measurement[key]++;
    return original.apply(this, args);
  };
}

const originalHmac = crypto.createHmac;
function countCrypto(enabled) {
  crypto.createHmac = enabled ? function (...args) {
    const current = measurement;
    if (current) current.hmacs++;
    const hmac = originalHmac(...args), update = hmac.update;
    hmac.update = function (input, ...rest) {
      if (current && input === 'void:vmd:capability-signing-key:v1') current.derivations++;
      if (current && typeof input === 'string' && input.startsWith('void-vmd-v1\n')) current.capabilities++;
      return update.call(this, input, ...rest);
    };
    return hmac;
  } : originalHmac;
  syncBuiltinESMExports();
}

process.on('message', async ({ id, command, count = false }) => {
  try {
    let result;
    if (command === 'start') {
      measurement = { pgWaitMs: [], pgWaitingMax: 0, statCalls: 0, originalCalls: 0, transportCalls: 0,
        hmacs: 0, derivations: 0, capabilities: 0, peakRss: process.memoryUsage().rss };
      countCrypto(count);
      loop = monitorEventLoopDelay({ resolution: 2 }); loop.enable();
      sampling = setInterval(() => {
        measurement.peakRss = Math.max(measurement.peakRss, process.memoryUsage().rss);
      }, 20);
      measurement.before = historyMetrics.getSnapshot();
      measurement.sentinelBefore = sentinel.getSnapshot();
      measurement.cpu = process.cpuUsage(); measurement.elu = performance.eventLoopUtilization();
      measurement.started = performance.now(); result = true;
    } else if (command === 'stop') {
      const cpu = process.cpuUsage(measurement.cpu), elu = performance.eventLoopUtilization(measurement.elu);
      clearInterval(sampling); loop.disable(); countCrypto(false);
      const { cpu: _cpu, elu: _elu, started, ...values } = measurement;
      result = { ...values, after: historyMetrics.getSnapshot(), sentinelAfter: sentinel.getSnapshot(),
        elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
        loop: { utilization: elu.utilization, p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 } };
      measurement = null;
    } else if (command === 'profileStart') {
      profiler = new Session(); profiler.connect(); await profiler.post('Profiler.enable');
      await profiler.post('Profiler.start'); result = true;
    } else if (command === 'profileStop') {
      result = (await profiler.post('Profiler.stop')).profile; profiler.disconnect(); profiler = null;
    } else throw new Error(`Unknown benchmark command ${command}`);
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error.stack }); }
});
