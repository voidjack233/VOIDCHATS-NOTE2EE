export class AuthAccountChangedError extends Error {
  readonly code = 'AUTH_ACCOUNT_CHANGED';
  constructor() {
    super('The account changed. This operation was cancelled.');
    this.name = 'AuthAccountChangedError';
  }
}

function newScope(accountId: string | null) {
  const controller = new AbortController();
  return { accountId, controller, signal: controller.signal };
}
let current = newScope(null);
const listeners = new Set<() => void>();
export type AuthOperationScope = ReturnType<typeof newScope>;
export const captureAuthOperation = (): AuthOperationScope => current;

export function assertAuthOperation(scope: AuthOperationScope): void {
  // Object identity keeps an A -> B -> A switch from reviving an old A task.
  if (scope !== current || scope.signal.aborted) throw new AuthAccountChangedError();
}

export function onAuthAccountChange(listener: () => void): void {
  listeners.add(listener);
}

export function setAuthOperationAccount(accountId: string | null): void {
  if (current.accountId === accountId && !current.signal.aborted) return;
  current.controller.abort(new AuthAccountChangedError());
  current = newScope(accountId);
  listeners.forEach(listener => listener());
}

// Includes caller cancellation without aborting a shared same-account refresh.
export function linkAuthOperation(scope: AuthOperationScope, caller?: AbortSignal | null) {
  const controller = new AbortController();
  const signals = [scope.signal, ...(caller ? [caller] : [])];
  const abort = () => controller.abort();
  signals.forEach(signal => {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return {
    signal: controller.signal,
    dispose: () => signals.forEach(signal => signal.removeEventListener('abort', abort)),
  };
}
