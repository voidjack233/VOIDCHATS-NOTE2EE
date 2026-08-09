const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'server', 'config.json'), 'utf8'),
);

const clusterEnabled = config.cluster.enabled;
const workers = config.cluster.workers || 4;
const gatewayMode = config.gateway?.mode || 'phoenix';

if (gatewayMode !== 'phoenix') {
  throw new Error(
    `Unsupported gateway.mode "${gatewayMode}". The Node gateway has been retired; use "phoenix".`,
  );
}

const commonEnv = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  VALKEY_PORT: 6379,
  VALKEY_DB: 0,
};

const apps = [
  {
    name: 'voidapp-api',
    script: 'server/entrypoints/account-server.js',
    instances: clusterEnabled ? workers : 1,
    exec_mode: clusterEnabled ? 'cluster' : 'fork',
    env: {
      ...commonEnv,
      PORT: 3001,
    },
    max_memory_restart: clusterEnabled ? '300M' : '500M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-message-service',
    script: 'server/entrypoints/message-server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      ...commonEnv,
      MESSAGE_SERVICE_PORT: 3002,
    },
    max_memory_restart: '350M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-vmd-service',
    script: 'startup/run-vmd-go.sh',
    instances: 1,
    exec_mode: 'fork',
    interpreter: 'none',
    env: {
      ...commonEnv,
      VMD_SERVICE_PORT: 3006,
    },
    max_memory_restart: '450M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-social-profile-service',
    script: 'server/entrypoints/social-server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      ...commonEnv,
      SOCIAL_SERVICE_PORT: 3004,
    },
    max_memory_restart: '350M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-conversation-service',
    script: 'server/entrypoints/conversation-server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      ...commonEnv,
      CONVERSATION_SERVICE_PORT: 3005,
    },
    max_memory_restart: '350M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-gateway-phoenix',
    script: 'startup/run-phoenix-gateway.sh',
    instances: 1,
    exec_mode: 'fork',
    interpreter: 'none',
    env: {
      NODE_ENV: 'production',
      MIX_ENV: 'prod',
      GATEWAY_PORT: 4001,
      GATEWAY_HOST: '127.0.0.1',
      VALKEY_PORT: 6379,
      VALKEY_DB: 0,
    },
    kill_timeout: 8_000,
    max_memory_restart: '300M',
    watch: false,
    autorestart: true,
  },
  {
    name: 'voidapp-worker-service',
    script: 'server/entrypoints/worker-server.js',
    instances: 1,
    exec_mode: 'fork',
    env: commonEnv,
    max_memory_restart: '2G',
    kill_timeout: 10_000,
    watch: false,
    autorestart: true,
  },
];

module.exports = { apps };
