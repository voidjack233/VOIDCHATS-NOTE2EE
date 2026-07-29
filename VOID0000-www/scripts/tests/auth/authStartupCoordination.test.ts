import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlightValue } from '../../../src/Services/Auth/client/singleFlightValue';
import { canStartAuthenticatedProviders } from '../../../src/Services/Auth/services/authStartupPolicy';
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

test('stale access with a valid refresh runs one ordered startup sequence for concurrent callers', async () => {
  const refreshGate = deferred<void>();
  const events: string[] = [];
  let refreshCalls = 0;
  let userCalls = 0;
  let csrfCalls = 0;
  let refreshResolved = false;

  const coordinator = createAuthStartupCoordinator(() => runAuthStartup({
    refreshSession: async () => {
      refreshCalls += 1;
      events.push('refresh:start');
      await refreshGate.promise;
      refreshResolved = true;
      events.push('refresh:success');
      return { success: true, status: 200 };
    },
    loadUser: async () => {
      assert.equal(refreshResolved, true);
      userCalls += 1;
      events.push('user');
      return user;
    },
    ensureCSRF: async () => {
      csrfCalls += 1;
      events.push('csrf');
      return 'csrf-token';
    },
  }));

  const requests = [
    coordinator.resolve(),
    coordinator.resolve(),
    coordinator.resolve(),
  ];
  assert.equal(refreshCalls, 1);

  refreshGate.resolve();
  const results = await Promise.all(requests);

  assert.deepEqual(events, ['refresh:start', 'refresh:success', 'user', 'csrf']);
  assert.equal(refreshCalls, 1);
  assert.equal(userCalls, 1);
  assert.equal(csrfCalls, 1);
  assert.ok(results.every((result) => result.status === 'authenticated'));
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
  });

  assert.deepEqual(result, { status: 'logged_out', user: null });
  assert.equal(userCalls, 0);
  assert.equal(csrfCalls, 0);
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
