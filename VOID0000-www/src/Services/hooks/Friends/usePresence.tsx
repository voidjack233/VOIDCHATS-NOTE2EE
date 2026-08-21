import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { useUser } from '../../Auth/UserContext';
import { gateway } from '../../Gateway/gateway';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import {
  fetchAppBootstrap,
  getCachedAppBootstrap,
  updateCachedAppBootstrapPreferences,
} from '../../bootstrap';
import {
  normalizePresenceMode,
  resolveOwnPresenceStatus,
  type PresenceActivityStatus,
  type PresenceMode,
  type PresenceStatus,
} from '../../Presence/presenceStatus';

const PRESENCE_STARTUP_FALLBACK_DELAY_MS = 1_500;

interface Presence {
  status: PresenceStatus;
  lastActive: number | null;
}

interface FriendPresenceSnapshot {
  id: string;
  status?: PresenceStatus;
  last_active?: number | null;
}

interface PresenceContextType {
  presences: Map<string, Presence>;
  getPresence: (userId: string) => Presence;
  presenceMode: PresenceMode;
  ownStatus: PresenceStatus;
  isUpdatingPresenceMode: boolean;
  presenceModeError: string | null;
  setPresenceMode: (mode: PresenceMode) => Promise<boolean>;
}

const PresenceContext = createContext<PresenceContextType | null>(null);
const PRESENCE_MIN_SYNC_GAP_MS = 10_000;

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [presences, setPresences] = useState<Map<string, Presence>>(new Map());
  const [activityStatus, setActivityStatus] = useState<PresenceActivityStatus>(
    () => gateway.getPresenceStatus(),
  );
  const [presenceMode, setPresenceModeState] = useState<PresenceMode>(() => (
    normalizePresenceMode(getCachedAppBootstrap()?.preferences?.presence_mode)
  ));
  const [isUpdatingPresenceMode, setIsUpdatingPresenceMode] = useState(false);
  const [presenceModeError, setPresenceModeError] = useState<string | null>(null);
  const lastSyncAtRef = useRef(0);
  const syncInFlightRef = useRef<Promise<void> | null>(null);
  const presenceModeRevisionRef = useRef(0);

  const ownStatus = resolveOwnPresenceStatus(presenceMode, activityStatus);

  const getPresence = useCallback((userId: string): Presence => {
    return presences.get(userId) || { status: 'offline', lastActive: null };
  }, [presences]);

  const setPresenceMode = useCallback(async (mode: PresenceMode): Promise<boolean> => {
    if (!user || isUpdatingPresenceMode) return false;

    setIsUpdatingPresenceMode(true);
    setPresenceModeError(null);

    try {
      const response = await fetchWithAuth('/api/users/preferences/presence', {
        method: 'PATCH',
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || 'Failed to update active status');
      }

      const persistedMode = normalizePresenceMode(payload.presence_mode);
      presenceModeRevisionRef.current += 1;
      setPresenceModeState(persistedMode);
      updateCachedAppBootstrapPreferences({ presence_mode: persistedMode });
      return true;
    } catch (error) {
      setPresenceModeError(
        error instanceof Error ? error.message : 'Failed to update active status',
      );
      return false;
    } finally {
      setIsUpdatingPresenceMode(false);
    }
  }, [isUpdatingPresenceMode, user]);

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      return;
    }

    const hydrationRevision = presenceModeRevisionRef.current;
    void fetchAppBootstrap().then((bootstrap) => {
      if (
        cancelled ||
        bootstrap?.user?.id !== user.id ||
        presenceModeRevisionRef.current !== hydrationRevision
      ) return;

      setPresenceModeState(normalizePresenceMode(bootstrap.preferences?.presence_mode));
    });

    const handleLocalActivity = (data: { status?: PresenceActivityStatus }) => {
      if (data.status === 'online' || data.status === 'idle') {
        setActivityStatus(data.status);
      }
    };

    const handlePresenceModeUpdate = (data: { mode?: unknown }) => {
      const nextMode = normalizePresenceMode(data.mode);
      presenceModeRevisionRef.current += 1;
      setPresenceModeState(nextMode);
      updateCachedAppBootstrapPreferences({ presence_mode: nextMode });
    };

    gateway.on('LOCAL_PRESENCE_ACTIVITY', handleLocalActivity);
    gateway.on('PRESENCE_MODE_UPDATE', handlePresenceModeUpdate);

    return () => {
      cancelled = true;
      gateway.off('LOCAL_PRESENCE_ACTIVITY', handleLocalActivity);
      gateway.off('PRESENCE_MODE_UPDATE', handlePresenceModeUpdate);
    };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    let startupFallbackTimer: number | null = null;

    if (!user) {
      setPresences(new Map());
      return;
    }

    lastSyncAtRef.current = 0;

    const applyPresenceSnapshot = (friends: FriendPresenceSnapshot[]) => {
      setPresences(prev => {
        const next = new Map(prev);

        friends.forEach(friend => {
          if (!friend?.id) return;

          next.set(friend.id, {
            status: friend.status || 'offline',
            lastActive: friend.last_active ?? null,
          });
        });

        return next;
      });
    };

    const syncPresenceFromFriends = async (force = false) => {
      const now = Date.now();
      if (syncInFlightRef.current) return syncInFlightRef.current;
      if (!force && now - lastSyncAtRef.current < PRESENCE_MIN_SYNC_GAP_MS) return;

      const task = (async () => {
        try {
          const res = await fetchWithAuth('/api/friends/presence');
          if (!res.ok) return;

          const data = await res.json();
          if (cancelled || !Array.isArray(data?.presences)) return;

          applyPresenceSnapshot(
            data.presences.map((presence: { user_id: string; status?: PresenceStatus; last_active?: number | null }) => ({
              id: presence.user_id,
              status: presence.status,
              last_active: presence.last_active,
            }))
          );
          lastSyncAtRef.current = Date.now();
        } catch (err) {
          console.error('Failed to refresh presence snapshot:', err);
        } finally {
          syncInFlightRef.current = null;
        }
      })();

      syncInFlightRef.current = task;
      return task;
    };

    // Phoenix currently sends an empty READY presence list because it does not
    // query Postgres. Always reconcile through the authenticated REST snapshot.
    const handleReady = (data: {
      presences?: Array<{ user_id: string; status: PresenceStatus; last_active?: number }>;
    }) => {
      if (Array.isArray(data.presences) && data.presences.length > 0) {
        applyPresenceSnapshot(data.presences.map((presence) => ({
          id: presence.user_id,
          status: presence.status,
          last_active: presence.last_active,
        })));
      }

      if (startupFallbackTimer !== null) {
        window.clearTimeout(startupFallbackTimer);
        startupFallbackTimer = null;
      }

      void syncPresenceFromFriends(true);
    };

    // Real-time presence updates
    const handlePresenceUpdate = (data: {
      user_id: string;
      status: PresenceStatus;
      last_active?: number;
    }) => {
      setPresences(prev => {
        const next = new Map(prev);
        next.set(data.user_id, {
          status: data.status,
          lastActive: data.last_active ?? null,
        });
        return next;
      });
    };

    // New friend accepted — set their presence
    const handleFriendAccept = (data: {
      friend: { id: string; status?: string; last_active?: number | null };
    }) => {
      if (data.friend.status) {
        setPresences(prev => {
          const next = new Map(prev);
          next.set(data.friend.id, {
            status: (data.friend.status as PresenceStatus) || 'offline',
            lastActive: data.friend.last_active ?? Date.now(),
          });
          return next;
        });
      }
    };

    const handleResumed = () => {
      void syncPresenceFromFriends(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncPresenceFromFriends();
      }
    };

    const handleWindowFocus = () => {
      void syncPresenceFromFriends();
    };

    const handleOnline = () => {
      void syncPresenceFromFriends(true);
    };

    // READY normally supplies the initial snapshot. Keep one delayed HTTP
    // fallback for providers that mount after READY has already fired.
    startupFallbackTimer = window.setTimeout(() => {
      startupFallbackTimer = null;
      void syncPresenceFromFriends();
    }, PRESENCE_STARTUP_FALLBACK_DELAY_MS);

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    gateway.on('PRESENCE_UPDATE', handlePresenceUpdate);
    gateway.on('FRIEND_ACCEPT', handleFriendAccept);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      if (startupFallbackTimer !== null) {
        window.clearTimeout(startupFallbackTimer);
      }
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      gateway.off('PRESENCE_UPDATE', handlePresenceUpdate);
      gateway.off('FRIEND_ACCEPT', handleFriendAccept);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, [user]);

  return (
    <PresenceContext.Provider value={{
      presences,
      getPresence,
      presenceMode,
      ownStatus,
      isUpdatingPresenceMode,
      presenceModeError,
      setPresenceMode,
    }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() {
  const context = useContext(PresenceContext);
  if (!context) throw new Error('usePresence must be used within PresenceProvider');
  return context;
}
