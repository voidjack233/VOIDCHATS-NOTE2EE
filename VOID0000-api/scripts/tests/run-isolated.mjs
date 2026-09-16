// Full backend suite, including immutable-session tests with fixed fixture ports.
// Application imports may load dotenv; fixture connection settings and generated
// auth secrets override it. No child process connects to live storage.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { services, root } from './media/fixtures.js';

for (const port of [15439, 16389]) {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
let cleanup;
try {
  const fixture = await services({ after: task => { cleanup = task; } }, { postgres: 15439, valkey: 16389, migrate: false });
  const tests = readdirSync(join(root, 'scripts/tests'), { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(join(root, 'scripts/tests', entry.name)).filter(name => name.endsWith('.test.js'))
      .map(name => join(root, 'scripts/tests', entry.name, name))).sort();
  // Profile tests create their own socket-only PostgreSQL on 5432. Other
  // security tests intentionally require the fixed, otherwise empty fixture DB.
  for (const profile of [false, true]) {
    const files = tests.filter(path => path.includes('/profile/') === profile);
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
      cwd: root, stdio: 'inherit', env: { ...fixture.env, NODE_ENV: 'test',
        HOME: process.env.HOME, PGPORT: profile ? '5432' : fixture.env.PGPORT,
        GO_BIN: process.env.GO_BIN, PROFILE_TEST_PG_BIN: process.env.PROFILE_TEST_PG_BIN,
        ACCESS_SECRET: randomBytes(32).toString('hex'), REFRESH_SECRET: randomBytes(32).toString('hex'),
        CSRF_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TOTP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        TWO_FACTOR_CODE_SECRET: randomBytes(32).toString('hex'),
      },
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    if (code) process.exitCode = code;
  }
} finally { await cleanup?.(); }
