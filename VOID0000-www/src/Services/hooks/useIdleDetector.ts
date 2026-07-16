import { useEffect, useRef } from 'react';
import { gateway } from '../Gateway/gateway';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'] as const;

export function useIdleDetector() {
  const isIdleRef = useRef(false);
  const lastActivityAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastActivityAtRef.current = Date.now();

    const publishStatus = (status: 'online' | 'idle') => {
      const isIdle = status === 'idle';
      if (isIdleRef.current === isIdle) return;

      isIdleRef.current = isIdle;
      gateway.setPresenceStatus(status);
    };

    const scheduleIdleCheck = () => {
      if (timerRef.current) clearTimeout(timerRef.current);

      const inactiveForMs = Date.now() - lastActivityAtRef.current;
      const remainingMs = Math.max(0, IDLE_TIMEOUT_MS - inactiveForMs);

      timerRef.current = setTimeout(() => {
        timerRef.current = null;

        if (Date.now() - lastActivityAtRef.current >= IDLE_TIMEOUT_MS) {
          publishStatus('idle');
          return;
        }

        scheduleIdleCheck();
      }, remainingMs);
    };

    const recordActivity = () => {
      lastActivityAtRef.current = Date.now();
      publishStatus('online');
      scheduleIdleCheck();
    };

    ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, recordActivity, { passive: true });
    });

    // Hiding a tab is not the same as becoming idle. Keep the inactivity
    // deadline running, and treat returning to the tab as fresh activity.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        recordActivity();
        return;
      }

      scheduleIdleCheck();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    gateway.setPresenceStatus('online');
    scheduleIdleCheck();

    return () => {
      ACTIVITY_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, recordActivity);
      });
      document.removeEventListener('visibilitychange', handleVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
}
