import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { asTwoFactorChallenge, authService, CaptchaData, logoutBestEffort } from '../services/auth';
import { onSessionInvalidated } from '../services/api';
import { outbox } from '../services/outbox';
import type { TwoFactorChallenge, User } from '../types/models';

const USER_CACHE_KEY = 'void_user';
const AUTH_RECHECK_INTERVAL = 5 * 60 * 1_000;

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable';

interface LoginResult {
  challenge?: TwoFactorChallenge;
}

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  cachedUser: User | null;
  isLoggingOut: boolean;
  login: (
    identifier: string,
    password: string,
    captcha?: CaptchaData,
  ) => Promise<LoginResult>;
  completeTwoFactor: (challenge: TwoFactorChallenge, code: string, method: string) => Promise<void>;
  refreshUser: () => Promise<User | null>;
  retry: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readCachedUser = async () => {
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) as User : null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [cachedUser, setCachedUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const checkingRef = useRef<Promise<void> | null>(null);
  const lastCheckedAt = useRef(0);

  const verify = useCallback(async () => {
    if (checkingRef.current) return checkingRef.current;
    const task = (async () => {
      const cached = await readCachedUser();
      setCachedUser(cached);
      const result = await authService.startup();
      lastCheckedAt.current = Date.now();
      if (result.status === 'authenticated' && result.user) {
        setUser(result.user);
        setCachedUser(result.user);
        setStatus('authenticated');
        await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(result.user));
        return;
      }
      if (result.status === 'unavailable') {
        setUser(cached);
        setStatus('unavailable');
        return;
      }
      setUser(null);
      setCachedUser(null);
      setStatus('unauthenticated');
      await Promise.all([
        AsyncStorage.multiRemove([USER_CACHE_KEY, 'void_native_bootstrap', 'void_pending_invite']),
        outbox.clear(),
      ]);
    })().finally(() => {
      checkingRef.current = null;
    });
    checkingRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  useEffect(() => onSessionInvalidated(() => {
    setUser(null);
    setCachedUser(null);
    setStatus('unauthenticated');
    void Promise.all([
      AsyncStorage.multiRemove([USER_CACHE_KEY, 'void_native_bootstrap', 'void_pending_invite']),
      outbox.clear(),
    ]);
  }), []);

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && Date.now() - lastCheckedAt.current >= AUTH_RECHECK_INTERVAL) {
        void verify();
      }
    });
    const networkSubscription = NetInfo.addEventListener((network) => {
      if (network.isConnected && status === 'unavailable') void verify();
    });
    return () => {
      appStateSubscription.remove();
      networkSubscription();
    };
  }, [status, verify]);

  const refreshUser = useCallback(async () => {
    const next = await authService.currentUser();
    setUser(next);
    if (next) {
      setCachedUser(next);
      setStatus('authenticated');
      await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(next));
    } else {
      setCachedUser(null);
      setStatus('unauthenticated');
      await AsyncStorage.removeItem(USER_CACHE_KEY);
    }
    return next;
  }, []);

  const login = useCallback(async (
    identifier: string,
    password: string,
    captcha?: CaptchaData,
  ): Promise<LoginResult> => {
    const response = await authService.login({ identifier, password, ...captcha });
    const challenge = asTwoFactorChallenge(response);
    if (challenge) return { challenge };
    await refreshUser();
    return {};
  }, [refreshUser]);

  const completeTwoFactor = useCallback(async (
    challenge: TwoFactorChallenge,
    code: string,
    method: string,
  ) => {
    await authService.verifyLogin2FA(challenge.twoFactorToken, code, method);
    await refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    setIsLoggingOut(true);
    try {
      await logoutBestEffort();
      await AsyncStorage.multiRemove([
        USER_CACHE_KEY,
        'void_native_bootstrap',
        'void_pending_invite',
      ]);
      await outbox.clear();
      setUser(null);
      setCachedUser(null);
      setStatus('unauthenticated');
    } finally {
      setIsLoggingOut(false);
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    cachedUser,
    status,
    isLoggingOut,
    login,
    completeTwoFactor,
    refreshUser,
    retry: verify,
    logout,
  }), [cachedUser, completeTwoFactor, isLoggingOut, login, logout, refreshUser, status, user, verify]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
