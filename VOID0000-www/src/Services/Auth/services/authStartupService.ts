import {
  fetchAppBootstrap,
  fetchAppBootstrapForAuthStartup,
} from '../../bootstrap';
import { preloadDefaultAuthenticatedChatRoute } from '../../../routeLoaders';
import {
  AuthSessionUnavailableError,
  ensureCSRFToken,
  fetchWithAuth,
  refreshAuthSession,
} from '../client/authClient';
import {
  createAuthStartupCoordinator,
  runAuthStartup,
} from './authStartupCoordinator';
import type { User } from '../types';

export const fetchFullUser = async (force = false): Promise<User | null> => {
  if (!force) {
    const bootstrap = await fetchAppBootstrap();
    if (bootstrap?.user?.username) {
      return {
        ...bootstrap.user,
        ...(bootstrap.account || {}),
      } as User;
    }
  }

  const authResponse = await fetchWithAuth('/api/me');
  if (!authResponse.ok) {
    if (authResponse.status === 401) return null;
    throw new AuthSessionUnavailableError();
  }
  const authData = await authResponse.json();
  if (!authData.success || !authData.user) {
    throw new AuthSessionUnavailableError();
  }

  const accountResponse = await fetchWithAuth('/api/users/account');
  if (!accountResponse.ok) {
    throw new AuthSessionUnavailableError();
  }
  const accountData = await accountResponse.json();
  return accountData.success && accountData.account
    ? { ...authData.user, ...accountData.account }
    : authData.user;
};

const fetchBootstrapUser = async (): Promise<User | null> => {
  const result = await fetchAppBootstrapForAuthStartup();
  if (result.status === 'invalid') return null;
  if (result.status === 'unavailable') {
    throw new AuthSessionUnavailableError();
  }

  const { bootstrap } = result;
  if (!bootstrap.user?.username) {
    throw new AuthSessionUnavailableError();
  }
  return {
    ...bootstrap.user,
    ...(bootstrap.account || {}),
  } as User;
};

const startupCoordinator = createAuthStartupCoordinator(() => runAuthStartup({
  refreshSession: refreshAuthSession,
  loadUser: fetchBootstrapUser,
  ensureCSRF: ensureCSRFToken,
  preloadAuthenticatedRoute: preloadDefaultAuthenticatedChatRoute,
}));

export const resolveAuthStartupSession = () => startupCoordinator.resolve();
export const resetAuthStartupSession = () => startupCoordinator.reset();
