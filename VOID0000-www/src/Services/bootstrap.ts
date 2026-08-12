import { fetchWithAuth } from './Auth/authServiceApi';
import { markStartupPerformance } from './Performance/startupPerformance';

export interface AppBootstrap {
  success: true;
  user: any;
  account: any;
  preferences: any | null;
  friends: any[];
  friend_requests: {
    incoming: any[];
    outgoing: any[];
  };
  conversations: any[];
}

export type AppBootstrapFetchResult =
  | { status: 'success'; bootstrap: AppBootstrap }
  | { status: 'invalid'; bootstrap: null }
  | { status: 'unavailable'; bootstrap: null };

interface AppBootstrapLoadOptions {
  force?: boolean;
  retryUnauthorized?: boolean;
}

interface AppBootstrapRequestOptions {
  retryUnauthorized: boolean;
}

export async function classifyAppBootstrapResponse(
  response: Response,
): Promise<AppBootstrapFetchResult> {
  if (response.status === 401) {
    return { status: 'invalid', bootstrap: null };
  }
  if (!response.ok) {
    return { status: 'unavailable', bootstrap: null };
  }

  try {
    const data = await response.json();
    if (data?.success === true && data.user && typeof data.user === 'object') {
      return { status: 'success', bootstrap: data as AppBootstrap };
    }
  } catch {
    // A malformed successful response is unavailable, not proof of logout.
  }
  return { status: 'unavailable', bootstrap: null };
}

export function createAppBootstrapStore(
  requestBootstrap: (
    options: AppBootstrapRequestOptions,
  ) => Promise<AppBootstrapFetchResult>,
) {
  let cachedBootstrap: AppBootstrap | null = null;
  let bootstrapPromise: Promise<AppBootstrapFetchResult> | null = null;
  let generation = 0;

  return {
    getCached(): AppBootstrap | null {
      return cachedBootstrap;
    },
    clear(): void {
      generation += 1;
      cachedBootstrap = null;
      bootstrapPromise = null;
    },
    load({
      force = false,
      retryUnauthorized = true,
    }: AppBootstrapLoadOptions = {}): Promise<AppBootstrapFetchResult> {
      if (!force && cachedBootstrap) {
        return Promise.resolve({ status: 'success', bootstrap: cachedBootstrap });
      }
      if (!force && bootstrapPromise) {
        return bootstrapPromise;
      }

      if (force) generation += 1;
      const requestGeneration = generation;
      const request = requestBootstrap({ retryUnauthorized })
        .then((result) => {
          if (generation === requestGeneration && result.status === 'success') {
            cachedBootstrap = result.bootstrap;
          }
          return result;
        })
        .finally(() => {
          if (bootstrapPromise === request) {
            bootstrapPromise = null;
          }
        });
      bootstrapPromise = request;
      return request;
    },
  };
}

const bootstrapStore = createAppBootstrapStore(async ({ retryUnauthorized }) => {
  markStartupPerformance('bootstrap-start');
  try {
    const response = await fetchWithAuth(
      '/api/bootstrap',
      {},
      { retryUnauthorized },
    );
    return await classifyAppBootstrapResponse(response);
  } catch (error) {
    console.warn('Failed to fetch app bootstrap:', error);
    return { status: 'unavailable', bootstrap: null };
  } finally {
    markStartupPerformance('bootstrap-end');
  }
});

export function getCachedAppBootstrap(): AppBootstrap | null {
  return bootstrapStore.getCached();
}

export function clearAppBootstrap(): void {
  bootstrapStore.clear();
}

export function fetchAppBootstrapResult(
  options: AppBootstrapLoadOptions = {},
): Promise<AppBootstrapFetchResult> {
  return bootstrapStore.load(options);
}

export function fetchAppBootstrapForAuthStartup(): Promise<AppBootstrapFetchResult> {
  return fetchAppBootstrapResult({ retryUnauthorized: false });
}

export async function fetchAppBootstrap(force = false): Promise<AppBootstrap | null> {
  const result = await fetchAppBootstrapResult({ force });
  return result.status === 'success' ? result.bootstrap : null;
}
