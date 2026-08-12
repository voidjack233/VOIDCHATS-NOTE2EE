import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { clearAppBootstrap } from '../../bootstrap';
import { gateway } from '../../Gateway/gateway';
import { markStartupPerformanceOnce } from '../../Performance/startupPerformance';
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  isAuthSessionUnavailableError,
} from '../client/authClient';
import { authService } from '../services/authService';
import {
  fetchFullUser,
  resetAuthStartupSession,
  resolveAuthStartupSession,
} from '../services/authStartupService';
import type { SessionVerificationStatus, User, UserContextType } from '../types';

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(true);
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
        resetAuthStartupSession();
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
      if (freshUser) {
        resetAuthStartupSession();
        setUser(freshUser);
      }
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
    clearAppBootstrap();
    resetAuthStartupSession();
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
      clearAppBootstrap();
      resetAuthStartupSession();
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
    void resolveAuthStartupSession()
      .then((result) => {
        if (cancelled) return;

        if (result.status === 'authenticated') {
          setUser(result.user);
          setAuthUnavailable(false);
          return;
        }

        if (result.status === 'logged_out') {
          setAuthUnavailable(false);
          clearLocalAuthState();
          return;
        }

        setAuthUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loading && !authUnavailable && user?.id) {
      markStartupPerformanceOnce('authenticated-render-ready');
    }
  }, [authUnavailable, loading, user?.id]);

  useEffect(() => {
    if (loading || authUnavailable || !user?.id) {
      gateway.disconnect();
      return;
    }
    gateway.connect(user.id);
    return () => gateway.disconnect();
  }, [authUnavailable, loading, user?.id]);

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
