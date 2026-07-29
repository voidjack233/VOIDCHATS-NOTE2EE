import type { RefreshResult, User } from '../types';

export type AuthStartupResult =
  | { status: 'authenticated'; user: User }
  | { status: 'logged_out'; user: null }
  | { status: 'unavailable'; user: null };

interface AuthStartupDependencies {
  refreshSession: () => Promise<RefreshResult>;
  loadUser: () => Promise<User | null>;
  ensureCSRF: () => Promise<string | null>;
}

export const runAuthStartup = async ({
  refreshSession,
  loadUser,
  ensureCSRF,
}: AuthStartupDependencies): Promise<AuthStartupResult> => {
  try {
    const refreshResult = await refreshSession();
    if (!refreshResult.success) {
      return refreshResult.failureKind === 'invalid'
        ? { status: 'logged_out', user: null }
        : { status: 'unavailable', user: null };
    }

    const user = await loadUser();
    if (!user) {
      return { status: 'logged_out', user: null };
    }

    await ensureCSRF();
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
