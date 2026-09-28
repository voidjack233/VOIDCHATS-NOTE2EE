// Passive diagnostics for real child processes; nothing here runs in the API.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const req = createRequire(resolve(__dirname, '../../../package.json'));
const cassandra = req('cassandra-driver');
const { HostMap } = req('cassandra-driver/lib/host');
const Connection = req('cassandra-driver/lib/connection');

// Select valid jitter extremes in the isolated regression only. Otherwise the
// old pool can win the reconnect race and bypass the Host-replacement defect.
if (process.env.SCYLLA_SHUTDOWN_TEST_HOST_REPLACEMENT === '1') {
  const Policy = cassandra.policies.reconnection.ExponentialReconnectionPolicy;
  Policy.prototype._addJitter = function (value) {
    if (value === 0) return 0;
    const control = new Error().stack.includes('ControlConnection._refresh');
    const first = !this.startWithNoDelay && value === this.baseDelay;
    return Math.floor(value * (control ? (first ? 1 : 0.85) : (value === this.maxDelay ? 1 : 1.15)));
  };
}

const clients = [], hosts = new Set(), connections = new Set(), ids = new WeakMap();
let next = 0;
function id(object) {
  if (!object) return null;
  if (!ids.has(object)) ids.set(object, ++next);
  return ids.get(object);
}
function log(event, data) {
  console.log('[CQL_TRACE]', JSON.stringify({ event, time: Date.now(), pid: process.pid, ...data }));
}

const OriginalClient = cassandra.Client;
cassandra.Client = new Proxy(OriginalClient, {
  construct(target, args, newTarget) {
    const client = Reflect.construct(target, args, newTarget);
    clients.push(client);
    log('client-created', { id: id(client), stack: new Error().stack });
    return client;
  },
});

const originalSet = HostMap.prototype.set;
HostMap.prototype.set = function (address, host) {
  const previous = this.get(address);
  hosts.add(host);
  log('host-map-set', { address, map: id(this), previous: id(previous), host: id(host) });
  return originalSet.call(this, address, host);
};

const bind = Connection.prototype.bindSocketListeners;
Connection.prototype.bindSocketListeners = function (...args) {
  connections.add(this);
  const socket = this.netClient;
  log('socket-bound', {
    connection: id(this), socket: id(socket), endpoint: this.endpoint,
    localPort: socket.localPort, remotePort: socket.remotePort,
  });
  socket.once('close', () => log('socket-closed', { connection: id(this), socket: id(socket) }));
  return bind.apply(this, args);
};
const close = Connection.prototype.close;
Connection.prototype.close = function (...args) {
  log('connection-close-called', {
    connection: id(this), endpoint: this.endpoint, connected: this.connected, isSocketOpen: this.isSocketOpen,
  });
  return close.apply(this, args);
};

function snapshot() {
  return {
    clientCount: clients.length,
    clients: clients.map((client) => ({
      id: id(client), connected: client.connected, connecting: client.connecting,
      isShuttingDown: client.isShuttingDown, currentHosts: client.hosts.values().map(id),
      controlHost: id(client.controlConnection.host), controlConnection: id(client.controlConnection.connection),
    })),
    hosts: [...hosts].map((host) => ({
      id: id(host), address: host.address, current: clients.some((client) => client.hosts.values().includes(host)),
      up: host.isUp(), pool: id(host.pool), poolState: host.pool._state, opening: host.pool._opening,
      reconnectScheduled: Boolean(host.pool._newConnectionTimeout), core: host.pool.coreConnectionsLength,
      connections: host.pool.connections.map(id),
    })),
    connections: [...connections].map((connection) => ({
      id: id(connection), endpoint: connection.endpoint, connected: connection.connected,
      isSocketOpen: connection.isSocketOpen,
      poolOwners: [...hosts].filter((host) => host.pool.connections.includes(connection)).map(id),
      socket: id(connection.netClient), destroyed: connection.netClient?.destroyed,
      localPort: connection.netClient?.localPort, remotePort: connection.netClient?.remotePort,
    })),
    handles: process._getActiveHandles().filter((handle) => handle.remotePort).map((handle) => ({
      socket: id(handle), localPort: handle.localPort, remotePort: handle.remotePort, destroyed: handle.destroyed,
    })),
    resources: process.getActiveResourcesInfo(),
  };
}

const shutdown = OriginalClient.prototype.shutdown;
OriginalClient.prototype.shutdown = function (...args) {
  log('shutdown-start', { state: snapshot() });
  const result = shutdown.apply(this, args);
  // Observe rejection without creating an unhandled diagnostic promise.
  result?.then(() => log('shutdown-resolved', { state: snapshot() }), () => {});
  return result;
};
process.on('SIGUSR2', () => log('snapshot', { state: snapshot() }));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    log('signal', { signal, state: snapshot() });
    // Unref'ed observers cannot keep a clean process alive.
    for (const ms of [100, 300]) setTimeout(() => log('after-signal', { ms, state: snapshot() }), ms).unref();
  });
}
process.once('beforeExit', (code) => log('natural-before-exit', { code, state: snapshot() }));
process.once('exit', (code) => log('exit', { code, state: snapshot() }));
