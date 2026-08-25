import valkey from '../../valkey.js';
import type { RequestHandler, Response } from 'express';

const SPAM_MSG_LIMITS = [
  { windowMs: 10_000, max: 15 },
  { windowMs: 60_000, max: 60 },
  { windowMs: 900_000, max: 300 },
];

const SPAM_MSG_TTL = 900;
const SPAM_MSG_BLOCKS = [30, 300, 1800];

const SPAM_FANOUT_LIMITS = [
  { windowMs: 300_000, max: 10 },
  { windowMs: 3_600_000, max: 25 },
];

const SPAM_FANOUT_TTL = 3600;
const SPAM_FANOUT_BLOCKS = [120, 900, 3600];

interface SpamBlock {
  msgHits: number;
  fanoutHits: number;
  blockedUntil?: number;
  reason?: string;
}

function parseBlock(raw: string | null): SpamBlock {
  if (!raw) {
    return { msgHits: 0, fanoutHits: 0 };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { msgHits: 0, fanoutHits: 0 };
    }
    return {
      msgHits: 'msgHits' in parsed ? Number(parsed.msgHits) || 0 : 0,
      fanoutHits: 'fanoutHits' in parsed ? Number(parsed.fanoutHits) || 0 : 0,
      blockedUntil: 'blockedUntil' in parsed
        ? Number(parsed.blockedUntil) || undefined
        : undefined,
      reason: 'reason' in parsed && typeof parsed.reason === 'string'
        ? parsed.reason
        : undefined,
    };
  } catch {
    return { msgHits: 0, fanoutHits: 0 };
  }
}

function sendSpamResponse(
  res: Response,
  blockSec: number,
  blockedUntil: number,
  reason: string | undefined,
) {
  const isFanout = reason === 'fanout';

  res.set('Retry-After', String(blockSec));
  return res.status(429).json({
    success: false,
    message: isFanout
      ? "You're messaging too many people too quickly. Please wait."
      : 'Too many messages. Please wait.',
    code: isFanout ? 'DM_SPAM_FANOUT_LIMIT' : 'DM_SPAM_RATE_LIMIT',
    retryAfter: `${blockSec} seconds`,
    retryAfterSeconds: blockSec,
    resetTime: blockedUntil,
  });
}

function nextBlockSeconds(hitCount: number, blocks: readonly number[]): number {
  const blockIndex = Math.min(Math.max(hitCount, 1) - 1, blocks.length - 1);
  return blocks[blockIndex];
}

export function createDmSpamGuard(): RequestHandler {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const conversationId = typeof req.params?.conversationId === 'string'
        ? req.params.conversationId
        : '';
      if (!userId) {
        return next();
      }

      const now = Date.now();
      const msgKey = `spam:msgs:${userId}`;
      const fanoutKey = `spam:fanout:${userId}`;
      const blockKey = `spam:block:${userId}`;
      const blockRaw = await valkey.get(blockKey);
      const block = parseBlock(blockRaw);

      if (block.blockedUntil && now < block.blockedUntil) {
        const retrySeconds = Math.max(1, Math.ceil((block.blockedUntil - now) / 1000));
        return sendSpamResponse(res, retrySeconds, block.blockedUntil, block.reason);
      }

      const pipeline = valkey.pipeline();

      pipeline.zremrangebyscore(msgKey, '-inf', now - SPAM_MSG_LIMITS[2].windowMs);
      for (const limit of SPAM_MSG_LIMITS) {
        pipeline.zcount(msgKey, now - limit.windowMs, '+inf');
      }
      pipeline.zadd(msgKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
      pipeline.expire(msgKey, SPAM_MSG_TTL);

      pipeline.zremrangebyscore(fanoutKey, '-inf', now - SPAM_FANOUT_LIMITS[1].windowMs);
      if (conversationId) {
        pipeline.zadd(fanoutKey, now, conversationId);
      }
      for (const limit of SPAM_FANOUT_LIMITS) {
        pipeline.zcount(fanoutKey, now - limit.windowMs, '+inf');
      }
      pipeline.expire(fanoutKey, SPAM_FANOUT_TTL);

      const results = await pipeline.exec();
      if (!results) {
        throw new Error('DM spam guard pipeline returned no result');
      }
      const msgCounts = [
        Number(results[1]?.[1] || 0),
        Number(results[2]?.[1] || 0),
        Number(results[3]?.[1] || 0),
      ];

      const fanoutOffset = conversationId ? 8 : 7;
      const fanoutCounts = [
        Number(results[fanoutOffset]?.[1] || 0),
        Number(results[fanoutOffset + 1]?.[1] || 0),
      ];

      for (let i = 0; i < SPAM_MSG_LIMITS.length; i += 1) {
        if (msgCounts[i] >= SPAM_MSG_LIMITS[i].max) {
          block.msgHits = (block.msgHits || 0) + 1;
          const blockSec = nextBlockSeconds(block.msgHits, SPAM_MSG_BLOCKS);
          block.blockedUntil = now + blockSec * 1000;
          block.reason = 'rate';

          await valkey.set(blockKey, JSON.stringify(block), 'EX', blockSec);
          return sendSpamResponse(res, blockSec, block.blockedUntil, block.reason);
        }
      }

      for (let i = 0; i < SPAM_FANOUT_LIMITS.length; i += 1) {
        if (fanoutCounts[i] >= SPAM_FANOUT_LIMITS[i].max) {
          block.fanoutHits = (block.fanoutHits || 0) + 1;
          const blockSec = nextBlockSeconds(block.fanoutHits, SPAM_FANOUT_BLOCKS);
          block.blockedUntil = now + blockSec * 1000;
          block.reason = 'fanout';

          await valkey.set(blockKey, JSON.stringify(block), 'EX', blockSec);
          return sendSpamResponse(res, blockSec, block.blockedUntil, block.reason);
        }
      }

      return next();
    } catch (err) {
      console.error('dmSpamGuard error:', err);
      return next();
    }
  };
}

export const dmSpamGuard = createDmSpamGuard();
