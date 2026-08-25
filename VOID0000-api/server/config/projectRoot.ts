import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = 'void-app';

interface ProjectRootOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}

function isProjectRoot(candidate: string): boolean {
  const packagePath = path.join(candidate, 'package.json');
  if (!existsSync(packagePath)) return false;

  try {
    const packageJson: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    return (
      typeof packageJson === 'object' &&
      packageJson !== null &&
      'name' in packageJson &&
      packageJson.name === EXPECTED_PACKAGE_NAME
    );
  } catch {
    return false;
  }
}

function findProjectRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectRoot({
  cwd = process.cwd(),
  env = process.env,
  moduleUrl = import.meta.url,
}: ProjectRootOptions = {}): string {
  const configuredRoot = String(env.VOIDAPP_ROOT || '').trim();
  if (configuredRoot) {
    const resolved = path.resolve(configuredRoot);
    if (!isProjectRoot(resolved)) {
      throw new Error(`VOIDAPP_ROOT does not identify the VOID API root: ${resolved}`);
    }
    return resolved;
  }

  const fromCwd = findProjectRoot(cwd);
  if (fromCwd) return fromCwd;

  const fromModule = findProjectRoot(path.dirname(fileURLToPath(moduleUrl)));
  if (fromModule) return fromModule;

  throw new Error('Unable to locate the VOID API project root');
}

export const projectRoot = resolveProjectRoot();

export function fromProjectRoot(...segments: string[]): string {
  return path.join(projectRoot, ...segments);
}
