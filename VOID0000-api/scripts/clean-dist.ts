import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fromProjectRoot = (...segments: string[]): string => path.join(projectRoot, ...segments);

await Promise.all(
  ['dist', '.dist-build', '.dist-previous'].map((directory) =>
    rm(fromProjectRoot(directory), {
      force: true,
      recursive: true,
    }),
  ),
);
