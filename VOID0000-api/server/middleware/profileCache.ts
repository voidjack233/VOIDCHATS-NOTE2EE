// middleware/profileCache.js
import valkey from '../valkey.js';
import type { RequestHandler } from 'express';

const CACHE_TTL = 300;       // 5 minutes fresh
const STALE_TTL = 600;       // 10 minutes stale (still servable while revalidating)

type ProfileData = Record<string, unknown>;

interface CachedProfile {
  data: ProfileData;
  stale: boolean;
}

function isProfileData(value: unknown): value is ProfileData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCachedProfile(raw: string): { data: ProfileData; cachedAt: number } | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('data' in parsed) ||
    !isProfileData(parsed.data) ||
    !('cachedAt' in parsed) ||
    typeof parsed.cachedAt !== 'number'
  ) {
    return null;
  }
  return { data: parsed.data, cachedAt: parsed.cachedAt };
}

/**
 * Cache user profile data in Valkey with stale-while-revalidate
 */
export const profileCache = {
  /**
   * Get cached profile — returns { data, stale } or null
   */
  async get(userId: string): Promise<CachedProfile | null> {
    try {
      const raw = await valkey.get(`profile:${userId}`);
      if (!raw) return null;

      const cached = parseCachedProfile(raw);
      if (!cached) return null;
      const age = Date.now() - cached.cachedAt;

      return {
        data: cached.data,
        stale: age > CACHE_TTL * 1000,
      };
    } catch (err) {
      console.error('Profile cache get error:', err);
      return null;
    }
  },

  /**
   * Store profile in cache
   */
  async set(userId: string, data: ProfileData): Promise<void> {
    try {
      const payload = {
        data,
        cachedAt: Date.now(),
      };
      await valkey.set(`profile:${userId}`, JSON.stringify(payload), 'EX', STALE_TTL);
    } catch (err) {
      console.error('Profile cache set error:', err);
    }
  },

  /**
   * Invalidate a user's cached profile (call after profile updates)
   */
  async invalidate(userId: string): Promise<void> {
    try {
      await valkey.del(`profile:${userId}`);
    } catch (err) {
      console.error('Profile cache invalidate error:', err);
    }
  },

  /**
   * Invalidate multiple users (e.g., after batch updates)
   */
  async invalidateMany(userIds: readonly string[]): Promise<void> {
    try {
      if (userIds.length === 0) return;
      const keys = userIds.map((id) => `profile:${id}`);
      await valkey.del(...keys);
    } catch (err) {
      console.error('Profile cache invalidateMany error:', err);
    }
  },
};

/**
 * Express middleware for profile read endpoints
 * Usage: router.get('/profile/:id', profileCacheMiddleware, handler)
 */
export const profileCacheMiddleware: RequestHandler = async (req, res, next) => {
  const userId = typeof req.params.id === 'string' ? req.params.id : req.user?.id;
  if (!userId) return next();

  try {
    const cached = await profileCache.get(userId);

    if (cached && !cached.stale) {
      // Fresh cache — serve directly
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    if (cached && cached.stale) {
      // Stale cache — serve stale, revalidate in background
      res.json({ success: true, ...cached.data, fromCache: true });

      // Attach flag so route handler knows to update cache in background
      req._revalidateCache = true;
      req._cacheUserId = userId;
      // Don't return — let the handler run in background to update cache
      // But we already sent the response, so the handler should just update cache
      return;
    }

    // No cache — let handler run normally
    req._cacheUserId = userId;
    next();
  } catch (err) {
    console.error('Profile cache middleware error:', err);
    next();
  }
};
