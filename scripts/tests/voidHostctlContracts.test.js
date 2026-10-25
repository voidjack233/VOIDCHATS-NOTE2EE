const assert = require('node:assert/strict');
const { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const readHostctl = () => readFile(path.join(root, 'scripts', 'void-hostctl.sh'), 'utf8');

test('host control script has a fixed VOID-only service allowlist', async () => {
  const script = await readHostctl();

  for (const unit of [
    'cloudflared.service',
    'nginx.service',
    'postgresql.service',
    'postgresql@16-main.service',
    'scylla-server.service',
    'valkey-server.service',
    'minio.service',
  ]) {
    assert.match(script, new RegExp(unit.replaceAll('.', '\\.')));
  }
  assert.match(script, /Unknown target '\$1'/);
  assert.doesNotMatch(script, /systemctl (?:start|stop|enable|disable) "\$target"/);
  assert.match(script, /require_target_units "\$target"/);
});

test('park removes exposure before stopping data and protects unrelated PM2 entries', async () => {
  const script = await readHostctl();
  const stopAll = script.slice(script.indexOf('stop_target() {'), script.indexOf('\nstop_target_one() {'));

  assert.ok(stopAll.indexOf('stop_apps') < stopAll.indexOf('stop_target edge'));
  assert.ok(stopAll.indexOf('stop_target edge') < stopAll.indexOf('stop_target minio'));
  assert.match(script, /Refusing to overwrite the PM2 dump because it contains non-VOID apps/);
  assert.match(script, /pm2 save --force/);
});

test('wake starts data before PM2 and exposes the stack last', async () => {
  const script = await readHostctl();
  const startAll = script.slice(script.indexOf('start_target() {'), script.indexOf('\nstart_target_one() {'));

  assert.ok(startAll.indexOf('start_target postgres') < startAll.indexOf('start_apps'));
  assert.ok(startAll.indexOf('start_target scylla') < startAll.indexOf('start_apps'));
  assert.ok(startAll.indexOf('start_target valkey') < startAll.indexOf('start_apps'));
  assert.ok(startAll.indexOf('start_target minio') < startAll.indexOf('start_apps'));
  assert.ok(startAll.indexOf('start_apps') < startAll.indexOf('start_target nginx'));
  assert.ok(startAll.indexOf('start_target nginx') < startAll.indexOf('start_target cloudflared'));
});

test('interactive mode loops until the operator quits', async () => {
  const script = await readHostctl();
  const loop = script.slice(script.indexOf('interactive_loop() {'), script.indexOf('\nmain() {'));

  assert.match(loop, /while :; do/);
  assert.match(loop, /\(interactive_menu\)/);
  assert.match(script, /q\|Q\) return 2/);
  assert.match(script, /\[ -n "\$command" \] \|\| \{ interactive_loop; return; \}/);
});

test('requirements check is read-only, distinguishes parked units, and never prints secrets', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'void-requirements-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scriptDir = path.join(fixture, 'scripts');
  const apiDir = path.join(fixture, 'VOID0000-api');
  const binDir = path.join(fixture, 'bin');
  const dotenvDir = path.join(apiDir, 'node_modules', 'dotenv');
  const systemctlLog = path.join(fixture, 'systemctl.log');
  await Promise.all([mkdir(scriptDir, { recursive: true }), mkdir(dotenvDir, { recursive: true }), mkdir(binDir)]);
  await copyFile(path.join(root, 'scripts', 'void-requirements.sh'), path.join(scriptDir, 'void-requirements.sh'));
  await writeFile(path.join(apiDir, '.env'), 'ACCESS_SECRET=never-print-this-secret\nREFRESH_SECRET=replace-me\n');
  await writeFile(path.join(dotenvDir, 'index.js'), `exports.parse = (buffer) => Object.fromEntries(
    String(buffer).trim().split('\\n').map((line) => line.split('='))
  );\n`);
  await writeFile(path.join(binDir, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CHECK_LOG"\ncase "$1" in cat) exit 0;; is-active) echo inactive; exit 3;; *) exit 99;; esac\n', { mode: 0o755 });

  const result = spawnSync('bash', [path.join(scriptDir, 'void-requirements.sh')], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: `${binDir}:${process.env.PATH}`, HOME: fixture, USER: 'fixture', CHECK_LOG: systemctlLog },
  });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /postgres: postgresql\.service is installed but inactive; expected when parked/);
  assert.match(result.stdout, /ACCESS_SECRET is set/);
  assert.match(result.stdout, /REFRESH_SECRET is placeholder/);
  assert.match(result.stdout, /Live database authentication, MinIO buckets and migration readiness not checked/);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-this-secret|replace-me/);
  const actions = (await readFile(systemctlLog, 'utf8')).trim().split('\n');
  assert.ok(actions.length > 0);
  assert.ok(actions.every((action) => action === 'cat' || action === 'is-active'));
});

test('requirements option is available in both the menu and command line', async () => {
  const script = await readHostctl();
  assert.match(script, /8\) requirements and readiness check/);
  assert.match(script, /requirements\) \[ -z "\$target" \]/);
});
