import type { RefreshResult, User } from '../types';
import { markStartupPerformance } from '../../Performance/startupPerformance';

export type AuthStartupResult =
  | { status: 'authenticated'; user: User }
  | { status: 'logged_out'; user: null }
  | { status: 'unavailable'; user: null };

interface AuthStartupDependencies {
  refreshSession: () => Promise<RefreshResult>;
  loadUser: () => Promise<User | null>;
  ensureCSRF: () => Promise<string | null>;
  preloadAuthenticatedRoute?: () => Promise<unknown> | unknown;
}

function startNonBlockingWarmup(task: () => Promise<unknown> | unknown): void {
  try {
    void Promise.resolve(task()).catch(() => undefined);
  } catch {
    // Route and CSRF warm-ups must never block authenticated read-only rendering.
  }
}

export const runAuthStartup = async ({
  refreshSession,
  loadUser,
  ensureCSRF,
  preloadAuthenticatedRoute,
}: AuthStartupDependencies): Promise<AuthStartupResult> => {
  try {
    markStartupPerformance('auth-refresh-start');
    let refreshResult: RefreshResult;
    try {
      refreshResult = await refreshSession();
    } finally {
      markStartupPerformance('auth-refresh-end');
    }
    if (!refreshResult.success) {
      return refreshResult.failureKind === 'invalid'
        ? { status: 'logged_out', user: null }
        : { status: 'unavailable', user: null };
    }

    const userRequest = loadUser();
    startNonBlockingWarmup(ensureCSRF);
    if (preloadAuthenticatedRoute) {
      startNonBlockingWarmup(preloadAuthenticatedRoute);
    }

    const user = await userRequest;
    if (!user) {
      return { status: 'logged_out', user: null };
    }

    return { status: 'authenticated', user };
  } catch {
    return { status: 'unavailable', user: null };
  }
};

export const createAuthStartupCoordinator = (
  resolveStartup: () => Promise<AuthStartupResult>,
) => {
  let inFlight: Promise<AuthStartupResult> | null = null;
  let settledResult: AuthStartupResult | null = null;
  let generation = 0;

  return {
    resolve(): Promise<AuthStartupResult> {
      if (settledResult) {
        return Promise.resolve(settledResult);
      }
      if (inFlight) {
        return inFlight;
      }

      const requestGeneration = generation;
      const request = resolveStartup()
        .then((result) => {
          if (generation === requestGeneration) {
            settledResult = result;
          }
          return result;
        })
        .finally(() => {
          if (inFlight === request) {
            inFlight = null;
          }
        });
      inFlight = request;
      return request;
    },
    reset(): void {
      generation += 1;
      inFlight = null;
      settledResult = null;
    },
  };
};
