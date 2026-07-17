import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { clearAppBootstrap, fetchAppBootstrap } from '../../bootstrap';
import { clearAttachmentCaches } from '../../Chat/attachmentService';
import { gateway } from '../../Gateway/gateway';
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  AuthSessionUnavailableError,
  fetchWithAuth,
  isAuthSessionUnavailableError,
} from '../client/authClient';
import { authService } from '../services/authService';
import type { SessionVerificationStatus, User, UserContextType } from '../types';

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(!localStorage.getItem(USER_STORAGE_KEY));
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [authRetrying, setAuthRetrying] = useState(false);
  const authRetryingRef = useRef(false);

  const setUser = (nextUser: User | null) => {
    const previousUserId = user?.id;
    setUserState(nextUser);
    if (nextUser) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(nextUser));
      if (previousUserId !== nextUser.id) {
        window.dispatchEvent(new Event('user-login'));
      }
    } else {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
  };

  const fetchFullUser = async (force = false): Promise<User | null> => {
    if (!force) {
      const bootstrap = await fetchAppBootstrap();
      if (bootstrap?.user?.username) return bootstrap.user as User;
    }

    const authResponse = await fetchWithAuth('/api/me');
    if (!authResponse.ok) {
      if (authResponse.status === 401) return null;
      throw new AuthSessionUnavailableError();
    }
    const authData = await authResponse.json();
    if (!authData.success || !authData.user) throw new AuthSessionUnavailableError();

    const accountResponse = await fetchWithAuth('/api/users/account');
    if (!accountResponse.ok) throw new AuthSessionUnavailableError();
    const accountData = await accountResponse.json();
    return accountData.success && accountData.account
      ? { ...authData.user, ...accountData.account }
      : authData.user;
  };

  const clearLocalAuthState = () => {
    setUser(null);
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('void_')) localStorage.removeItem(key);
    });
  };
  const clearLocalAuthStateRef = useRef(clearLocalAuthState);
  clearLocalAuthStateRef.current = clearLocalAuthState;

  const verifySession = async (): Promise<SessionVerificationStatus> => {
    try {
      const freshUser = await fetchFullUser(true);
      if (freshUser?.username) {
        setUser(freshUser);
        setAuthUnavailable(false);
        return 'authenticated';
      }
      setAuthUnavailable(false);
      clearLocalAuthState();
      return 'invalid';
    } catch (error) {
      if (!isAuthSessionUnavailableError(error)) {
        console.error('Session verification failed:', error);
      }
      setAuthUnavailable(true);
      return 'unavailable';
    }
  };

  const refreshUser = async () => {
    try {
      const freshUser = await fetchFullUser(true);
      if (freshUser) setUser(freshUser);
      setAuthUnavailable(false);
    } catch (error) {
      if (isAuthSessionUnavailableError(error)) {
        setAuthUnavailable(true);
      } else {
        console.error('Failed to refresh user:', error);
      }
    }
  };

  const retryAuth = async () => {
    if (authRetryingRef.current) return;
    authRetryingRef.current = true;
    setAuthRetrying(true);
    try {
      await verifySession();
    } finally {
      authRetryingRef.current = false;
      setAuthRetrying(false);
    }
  };

  const logout = async () => {
    setIsLoggingOut(true);
    gateway.disconnect();
    clearAttachmentCaches();
    clearAppBootstrap();
    try {
      await authService.logout();
    } finally {
      clearLocalAuthState();
      setIsLoggingOut(false);
    }
  };

  useEffect(() => {
    const handleSessionInvalidated = () => {
      gateway.disconnect();
      clearAttachmentCaches();
      clearAppBootstrap();
      authRetryingRef.current = false;
      setAuthRetrying(false);
      setAuthUnavailable(false);
      setLoading(false);
      clearLocalAuthStateRef.current();
    };

    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);
    return () => {
      window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void verifySession().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      gateway.disconnect();
      return;
    }
    gateway.connect(user.id);
    return () => gateway.disconnect();
  }, [user?.id]);

  return (
    <UserContext.Provider value={{
      user,
      loading,
      authUnavailable,
      authRetrying,
      isLoggingOut,
      setUser,
      refreshUser,
      verifySession,
      retryAuth,
      logout,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (!context) throw new Error('useUser must be used within UserProvider');
  return context;
}
