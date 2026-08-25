import { rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fromProjectRoot = (...segments: string[]): string => path.join(projectRoot, ...segments);

function getErrorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

const outputDirectory = fromProjectRoot('dist');
const stagedDirectory = fromProjectRoot('.dist-build');
const previousDirectory = fromProjectRoot('.dist-previous');
const tscPath = fromProjectRoot('node_modules', 'typescript', 'bin', 'tsc');

await rm(stagedDirectory, { recursive: true, force: true });

const exitCode = await new Promise<number>((resolve, reject) => {
  const compiler = spawn(
    process.execPath,
    [tscPath, '-p', 'tsconfig.build.json', '--outDir', stagedDirectory],
    {
      cwd: fromProjectRoot(),
      stdio: 'inherit',
    },
  );

  compiler.once('error', reject);
  compiler.once('exit', (code, signal) => {
    if (signal) {
      reject(new Error(`TypeScript compiler terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  await rm(stagedDirectory, { recursive: true, force: true });
  process.exitCode = exitCode;
} else {
  await rm(previousDirectory, { recursive: true, force: true });

  let movedPreviousOutput = false;
  try {
    await rename(outputDirectory, previousDirectory);
    movedPreviousOutput = true;
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') throw error;
  }

  try {
    await rename(stagedDirectory, outputDirectory);
  } catch (error) {
    if (movedPreviousOutput) {
      await rename(previousDirectory, outputDirectory);
    }
    throw error;
  }

  await rm(previousDirectory, { recursive: true, force: true });
}
