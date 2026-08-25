import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  projectRoot,
  resolveProjectRoot,
} from '../../../server/config/projectRoot.js';

const cleanEnv = { ...process.env, VOIDAPP_ROOT: '' };

test('project root resolves from a nested working directory', () => {
  assert.equal(
    resolveProjectRoot({
      cwd: path.join(projectRoot, 'server', 'routes'),
      env: cleanEnv,
    }),
    projectRoot,
  );
});

test('project root falls back to the module location outside the repository cwd', () => {
  assert.equal(
    resolveProjectRoot({
      cwd: '/tmp',
      env: cleanEnv,
      moduleUrl: pathToFileURL(
        path.join(projectRoot, 'dist', 'server', 'config', 'projectRoot.js'),
      ).href,
    }),
    projectRoot,
  );
});

test('a valid explicit project root takes precedence', () => {
  assert.equal(
    resolveProjectRoot({
      cwd: '/tmp',
      env: { ...process.env, VOIDAPP_ROOT: projectRoot },
      moduleUrl: pathToFileURL('/tmp/unrelated/module.js').href,
    }),
    projectRoot,
  );
});

test('an invalid explicit project root fails closed', () => {
  assert.throws(
    () =>
      resolveProjectRoot({
        cwd: projectRoot,
        env: { ...process.env, VOIDAPP_ROOT: '/tmp' },
      }),
    /VOIDAPP_ROOT does not identify the VOID API root/,
  );
});
