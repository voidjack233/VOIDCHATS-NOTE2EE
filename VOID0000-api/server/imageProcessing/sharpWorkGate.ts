interface PendingSharpWork {
  run(): Promise<void>;
}

export interface SharpWorkStats {
  active: number;
  pending: number;
  maxConcurrent: number;
}

function resolvePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

const MAX_CONCURRENT_SHARP_WORK = resolvePositiveInteger(
  process.env.SHARP_MAX_CONCURRENT_WORK,
  1,
  4,
);

let activeWork = 0;
const pendingWork: PendingSharpWork[] = [];

function drain(): void {
  while (activeWork < MAX_CONCURRENT_SHARP_WORK && pendingWork.length > 0) {
    const item = pendingWork.shift();
    if (!item) return;
    activeWork += 1;

    Promise.resolve()
      .then(item.run)
      .finally(() => {
        activeWork -= 1;
        drain();
      });
  }
}

export function runSharpWork<Result>(
  task: () => Result | PromiseLike<Result>,
): Promise<Result> {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('Sharp work must be a function'));
  }

  return new Promise((resolve, reject) => {
    pendingWork.push({
      async run() {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      },
    });
    drain();
  });
}

export function getSharpWorkStats(): SharpWorkStats {
  return {
    active: activeWork,
    pending: pendingWork.length,
    maxConcurrent: MAX_CONCURRENT_SHARP_WORK,
  };
}
