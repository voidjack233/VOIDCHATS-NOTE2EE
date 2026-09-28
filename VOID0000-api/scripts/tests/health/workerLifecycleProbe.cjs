// Test-only ownership tracing. The real worker and its resource APIs run unchanged.
require('./scyllaLifecycleProbe.cjs');
const { createHook } = require('node:async_hooks');
const net = require('node:net');
const Redis = require('ioredis');
const pg = require('pg');
const { QueueBase, Worker } = require('bullmq');
const sharp = require('sharp');

const redis = new Map(), pools = new Map(), queues = new Set(), servers = new Map();
const timers = new Map(), activeJobs = new Set();
const activeSharp = new Set();
const ids = new WeakMap();
let nextId = 0;
function id(object) {
  if (!object) return null;
  if (!ids.has(object)) ids.set(object, ++nextId);
  return ids.get(object);
}
function log(event, details = {}) {
  console.log('[WORKER_TRACE]', JSON.stringify({ event, pid: process.pid, time: Date.now(), ...details }));
}
function stack() { return new Error().stack; }
function socketState(socket) {
  return { id: id(socket), destroyed: socket?.destroyed, localPort: socket?.localPort,
    remotePort: socket?.remotePort, referenced: socket?._handle?.hasRef() };
}
createHook({
  init(asyncId, type, trigger, resource) {
    if (type !== 'Timeout') return;
    const origin = stack();
    if (/\/server\/|\/bullmq\/|\/pg-pool\/|\/cassandra-driver\//.test(origin)) {
      timers.set(asyncId, { resource, stack: origin });
    }
  },
  destroy(asyncId) { timers.delete(asyncId); },
}).enable();

const connect = Redis.prototype.connect;
Redis.prototype.connect = function (...args) {
  if (!redis.has(this)) {
    redis.set(this, { stack: stack() });
    log('redis-created', { id: id(this), ...redis.get(this) });
    this.on('connect', () => {
      const socket = this.stream;
      log('redis-connected', { id: id(this), socket: socketState(socket) });
      socket.once('close', () => log('redis-socket-closed', { id: id(this), socket: id(socket) }));
    });
  }
  return connect.apply(this, args);
};

const createScripts = QueueBase.prototype.createScripts;
QueueBase.prototype.createScripts = function (...args) {
  queues.add(this);
  return createScripts.apply(this, args);
};
const processJob = Worker.prototype.callProcessJob;
Worker.prototype.callProcessJob = async function (job, ...args) {
  activeJobs.add(job.id);
  log('job-started', { jobId: job.id });
  try { return await processJob.call(this, job, ...args); }
  finally { activeJobs.delete(job.id); log('job-finished', { jobId: job.id }); }
};
const workerClose = Worker.prototype.close;
Worker.prototype.close = function (...args) {
  log('worker-close-start', { activeJobs: [...activeJobs] });
  return workerClose.apply(this, args).then((result) => {
    log('worker-close-done', { activeJobs: [...activeJobs] }); return result;
  });
};

const poolConnect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (...args) {
  if (!pools.has(this)) {
    pools.set(this, { stack: stack(), queries: 0, clients: new Set() });
    this.on('connect', (client) => pools.get(this).clients.add(client));
  }
  return poolConnect.apply(this, args);
};
const poolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (...args) {
  const result = poolQuery.apply(this, args);
  if (result?.then) {
    const state = pools.get(this);
    state.queries++;
    result.then(() => state.queries--, () => state.queries--);
  }
  return result;
};
const poolEnd = pg.Pool.prototype.end;
pg.Pool.prototype.end = function (...args) {
  log('pg-end-start');
  return poolEnd.apply(this, args).then((result) => {
    log('pg-end-done');
    if (process.env.WORKER_SHUTDOWN_TEST_FAIL_PG_END === '1') throw new Error('Injected PG close rejection');
    return result;
  });
};
const toBuffer = sharp.prototype.toBuffer;
sharp.prototype.toBuffer = function (...args) {
  const result = toBuffer.apply(this, args);
  if (result?.then) {
    activeSharp.add(result);
    result.then(() => activeSharp.delete(result), () => activeSharp.delete(result));
  }
  return result;
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  servers.set(this, { path: typeof args[0] === 'string' ? args[0] : undefined, stack: stack() });
  return listen.apply(this, args);
};

function snapshot() {
  return {
    redis: [...redis].map(([client, origin]) => ({
      id: id(client), ...origin, status: client.status, socket: socketState(client.stream),
      queueOwners: [...queues].flatMap((queue) => ['connection', 'blockingConnection'].flatMap((key) =>
        queue[key]?._client?.stream === client.stream
          ? [{ type: queue.constructor.name, name: queue.name, connection: key, closed: queue.closed }] : [])),
    })),
    queues: [...queues].map((queue) => ({ type: queue.constructor.name, name: queue.name,
      closed: queue.closed, closing: Boolean(queue.closing) })),
    postgres: [...pools].map(([pool, state]) => ({ id: id(pool), stack: state.stack,
      ending: pool.ending, ended: pool.ended, total: pool.totalCount, idle: pool.idleCount,
      queries: state.queries, sockets: [...state.clients].map((client) => socketState(client.connection.stream)) })),
    servers: [...servers].map(([server, origin]) => ({ ...origin, listening: server.listening })),
    timers: [...timers.values()].filter(({ resource }) => !resource._destroyed).map(({ resource, stack }) => ({
      delay: resource._idleTimeout, referenced: resource.hasRef(), stack,
    })),
    activeJobs: [...activeJobs], activeSharpPromises: activeSharp.size, connectedToPm2: process.connected === true,
    handles: process._getActiveHandles().filter((handle) => handle instanceof net.Socket && handle.remotePort)
      .map(socketState), resources: process.getActiveResourcesInfo(),
  };
}
const exit = process.exit;
process.exit = function (code) {
  log('explicit-exit', { code, state: snapshot() });
  return exit.call(process, code);
};
process.on('SIGUSR2', () => log('snapshot', { state: snapshot() }));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => log('signal', { signal, state: snapshot() }));
}
process.once('beforeExit', (code) => log('natural-before-exit', { code, state: snapshot() }));
process.once('exit', (code) => log('exit', { code, state: snapshot() }));
