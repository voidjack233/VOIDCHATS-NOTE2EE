import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSingleFlightValue } from '../../../src/Services/Auth/client/singleFlightValue';
import { canStartAuthenticatedProviders } from '../../../src/Services/Auth/services/authStartupPolicy';
import {
  classifyAppBootstrapResponse,
  createAppBootstrapStore,
  type AppBootstrap,
  type AppBootstrapFetchResult,
} from '../../../src/Services/bootstrap';
import {
  createAuthStartupCoordinator,
  runAuthStartup,
  type AuthStartupResult,
} from '../../../src/Services/Auth/services/authStartupCoordinator';
import type { User } from '../../../src/Services/Auth/types';

const user: User = {
  id: 'user-1',
  email: 'user@example.com',
  username: 'user',
};

const appBootstrap: AppBootstrap = {
  success: true,
  user,
  account: { display_name: 'User' },
  preferences: { theme: 'void' },
  friends: [],
  friend_requests: { incoming: [], outgoing: [] },
  conversations: [],
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

test('valid refresh starts one bootstrap, CSRF warm-up, and route preload for concurrent callers', async () => {
  const refreshGate = deferred<void>();
  const bootstrapGate = deferred<User | null>();
  const csrfGate = deferred<string | null>();
  let refreshCalls = 0;
  let bootstrapCalls = 0;
  let csrfCalls = 0;
  let preloadCalls = 0;
  let refreshResolved = false;

  const coordinator = createAuthStartupCoordinator(() => runAuthStartup({
    refreshSession: async () => {
      refreshCalls += 1;
      await refreshGate.promise;
      refreshResolved = true;
      return { success: true, status: 200 };
    },
    loadUser: async () => {
      assert.equal(refreshResolved, true);
      bootstrapCalls += 1;
      return bootstrapGate.promise;
    },
    ensureCSRF: async () => {
      csrfCalls += 1;
      return csrfGate.promise;
    },
    preloadAuthenticatedRoute: async () => {
      preloadCalls += 1;
    },
  }));

  const requests = [
    coordinator.resolve(),
    coordinator.resolve(),
    coordinator.resolve(),
  ];
  assert.equal(refreshCalls, 1);

  refreshGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bootstrapCalls, 1);
  assert.equal(csrfCalls, 1);
  assert.equal(preloadCalls, 1);

  bootstrapGate.resolve(user);
  const results = await Promise.all(requests);

  assert.equal(refreshCalls, 1);
  assert.equal(bootstrapCalls, 1);
  assert.equal(csrfCalls, 1);
  assert.ok(results.every((result) => result.status === 'authenticated'));
  csrfGate.resolve('csrf-token');
});

test('concurrent CSRF callers share one request and reuse the cached token', async () => {
  const tokenState = createSingleFlightValue<string>();
  const tokenGate = deferred<string | null>();
  let tokenRequests = 0;
  const loadToken = () => {
    tokenRequests += 1;
    return tokenGate.promise;
  };

  const requests = [
    tokenState.getOrLoad(loadToken),
    tokenState.getOrLoad(loadToken),
    tokenState.getOrLoad(loadToken),
  ];
  assert.equal(tokenRequests, 1);

  tokenGate.resolve('csrf-token');
  assert.deepEqual(await Promise.all(requests), [
    'csrf-token',
    'csrf-token',
    'csrf-token',
  ]);
  assert.equal(await tokenState.getOrLoad(loadToken), 'csrf-token');
  assert.equal(tokenRequests, 1);
});

test('an invalid refresh resolves logged out without starting protected requests', async () => {
  let userCalls = 0;
  let csrfCalls = 0;
  let preloadCalls = 0;
  const result = await runAuthStartup({
    refreshSession: async () => ({
      success: false,
      failureKind: 'invalid',
      status: 401,
      code: 'REFRESH_TOKEN_INVALID',
    }),
    loadUser: async () => {
      userCalls += 1;
      return user;
    },
    ensureCSRF: async () => {
      csrfCalls += 1;
      return 'csrf-token';
    },
    preloadAuthenticatedRoute: () => {
      preloadCalls += 1;
    },
  });

  assert.deepEqual(result, { status: 'logged_out', user: null });
  assert.equal(userCalls, 0);
  assert.equal(csrfCalls, 0);
  assert.equal(preloadCalls, 0);
});

test('an unavailable refresh preserves the session without starting protected requests', async () => {
  let protectedCalls = 0;
  const result = await runAuthStartup({
    refreshSession: async () => ({ success: false, failureKind: 'unavailable' }),
    loadUser: async () => {
      protectedCalls += 1;
      return user;
    },
    ensureCSRF: async () => {
      protectedCalls += 1;
      return null;
    },
    preloadAuthenticatedRoute: () => {
      protectedCalls += 1;
    },
  });

  assert.deepEqual(result, { status: 'unavailable', user: null });
  assert.equal(protectedCalls, 0);
});

test('bootstrap invalid and unavailable outcomes preserve distinct auth semantics', async (t) => {
  await t.test('bootstrap 401 logs out', async () => {
    const result = await runAuthStartup({
      refreshSession: async () => ({ success: true, status: 200 }),
      loadUser: async () => null,
      ensureCSRF: async () => null,
    });
    assert.deepEqual(result, { status: 'logged_out', user: null });
  });

  for (const name of ['bootstrap 500', 'bootstrap network failure']) {
    await t.test(`${name} preserves the local session`, async () => {
      const result = await runAuthStartup({
        refreshSession: async () => ({ success: true, status: 200 }),
        loadUser: async () => {
          throw new Error(name);
        },
        ensureCSRF: async () => null,
      });
      assert.deepEqual(result, { status: 'unavailable', user: null });
    });
  }
});

test('CSRF warm-up failure does not block authenticated read-only rendering', async () => {
  const result = await runAuthStartup({
    refreshSession: async () => ({ success: true, status: 200 }),
    loadUser: async () => user,
    ensureCSRF: async () => {
      throw new Error('csrf unavailable');
    },
  });

  assert.deepEqual(result, { status: 'authenticated', user });
});

test('bootstrap HTTP responses distinguish invalid sessions from temporary failures', async () => {
  assert.deepEqual(
    await classifyAppBootstrapResponse(new Response(null, { status: 401 })),
    { status: 'invalid', bootstrap: null },
  );
  assert.deepEqual(
    await classifyAppBootstrapResponse(new Response(null, { status: 500 })),
    { status: 'unavailable', bootstrap: null },
  );
  assert.deepEqual(
    await classifyAppBootstrapResponse(new Response('not json', { status: 200 })),
    { status: 'unavailable', bootstrap: null },
  );

  const success = await classifyAppBootstrapResponse(new Response(
    JSON.stringify(appBootstrap),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  assert.deepEqual(success, { status: 'success', bootstrap: appBootstrap });
});

test('concurrent bootstrap consumers share one request and reuse its cache', async () => {
  const bootstrapGate = deferred<AppBootstrapFetchResult>();
  let requests = 0;
  const store = createAppBootstrapStore(async () => {
    requests += 1;
    return bootstrapGate.promise;
  });

  const consumers = [store.load(), store.load(), store.load()];
  assert.equal(requests, 1);
  bootstrapGate.resolve({ status: 'success', bootstrap: appBootstrap });
  assert.ok((await Promise.all(consumers)).every((result) => result.status === 'success'));
  assert.equal(store.getCached(), appBootstrap);
  assert.equal((await store.load()).status, 'success');
  assert.equal(requests, 1);
});

test('clearing bootstrap during a request prevents stale startup data from being restored', async () => {
  const firstGate = deferred<AppBootstrapFetchResult>();
  const secondBootstrap = { ...appBootstrap, user: { ...user, id: 'user-2' } };
  let requests = 0;
  const store = createAppBootstrapStore(async () => {
    requests += 1;
    return requests === 1
      ? firstGate.promise
      : { status: 'success', bootstrap: secondBootstrap };
  });

  const staleRequest = store.load();
  store.clear();
  const freshResult = await store.load();
  firstGate.resolve({ status: 'success', bootstrap: appBootstrap });
  await staleRequest;

  assert.deepEqual(freshResult, { status: 'success', bootstrap: secondBootstrap });
  assert.equal(store.getCached(), secondBootstrap);
  assert.equal(requests, 2);
});

test('forced bootstrap refresh supersedes an older in-flight request', async () => {
  const firstGate = deferred<AppBootstrapFetchResult>();
  const freshBootstrap = { ...appBootstrap, user: { ...user, id: 'user-2' } };
  let requests = 0;
  const store = createAppBootstrapStore(async () => {
    requests += 1;
    return requests === 1
      ? firstGate.promise
      : { status: 'success', bootstrap: freshBootstrap };
  });

  const olderRequest = store.load();
  const forcedResult = await store.load({ force: true });
  firstGate.resolve({ status: 'success', bootstrap: appBootstrap });
  await olderRequest;

  assert.deepEqual(forcedResult, { status: 'success', bootstrap: freshBootstrap });
  assert.equal(store.getCached(), freshBootstrap);
  assert.equal(requests, 2);
});

test('successful initialization enables protected startup providers once', () => {
  let providerStarts = 0;
  let providersStarted = false;
  const renderProviderBoundary = ({
    loading,
    authUnavailable,
    currentUser,
  }: {
    loading: boolean;
    authUnavailable: boolean;
    currentUser: User | null;
  }) => {
    const enabled = canStartAuthenticatedProviders({
      user: currentUser,
      loading,
      authUnavailable,
    });
    if (enabled && !providersStarted) {
      providersStarted = true;
      providerStarts += 1;
    }
    return enabled;
  };

  assert.equal(renderProviderBoundary({
    currentUser: user,
    loading: true,
    authUnavailable: false,
  }), false);
  assert.equal(canStartAuthenticatedProviders({
    user,
    loading: false,
    authUnavailable: true,
  }), false);
  assert.equal(canStartAuthenticatedProviders({
    user: null,
    loading: false,
    authUnavailable: false,
  }), false);
  assert.equal(canStartAuthenticatedProviders({
    user,
    loading: false,
    authUnavailable: false,
  }), true);
  assert.equal(renderProviderBoundary({
    currentUser: user,
    loading: false,
    authUnavailable: false,
  }), true);
  assert.equal(renderProviderBoundary({
    currentUser: user,
    loading: false,
    authUnavailable: false,
  }), true);
  assert.equal(providerStarts, 1);
});

test('reset during an in-flight startup cannot overwrite a newer result', async () => {
  const firstGate = deferred<AuthStartupResult>();
  let attempts = 0;
  const coordinator = createAuthStartupCoordinator(() => {
    attempts += 1;
    if (attempts === 1) {
      return firstGate.promise;
    }
    return Promise.resolve({ status: 'logged_out', user: null });
  });

  const first = coordinator.resolve();
  coordinator.reset();
  const second = await coordinator.resolve();
  firstGate.resolve({ status: 'authenticated', user });
  await first;
  const cached = await coordinator.resolve();

  assert.deepEqual(second, { status: 'logged_out', user: null });
  assert.deepEqual(cached, second);
  assert.equal(attempts, 2);
});

test('logout and session invalidation clear bootstrap and startup coordinator state', async () => {
  const userContextSource = await readFile(
    new URL('../../../src/Services/Auth/context/UserContext.tsx', import.meta.url),
    'utf8',
  );

  assert.match(userContextSource, /const logout = async \(\) => \{[\s\S]*clearAppBootstrap\(\);[\s\S]*resetAuthStartupSession\(\);/);
  assert.match(userContextSource, /const handleSessionInvalidated = \(\) => \{[\s\S]*clearAppBootstrap\(\);[\s\S]*resetAuthStartupSession\(\);/);
});
