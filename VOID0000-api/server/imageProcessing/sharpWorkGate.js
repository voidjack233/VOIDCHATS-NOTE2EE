function resolvePositiveInteger(value, fallback, maximum) {
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
const pendingWork = [];

function drain() {
  while (activeWork < MAX_CONCURRENT_SHARP_WORK && pendingWork.length > 0) {
    const item = pendingWork.shift();
    activeWork += 1;

    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeWork -= 1;
        drain();
      });
  }
}

export function runSharpWork(task) {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('Sharp work must be a function'));
  }

  return new Promise((resolve, reject) => {
    pendingWork.push({ task, resolve, reject });
    drain();
  });
}

export function getSharpWorkStats() {
  return {
    active: activeWork,
    pending: pendingWork.length,
    maxConcurrent: MAX_CONCURRENT_SHARP_WORK,
  };
}
