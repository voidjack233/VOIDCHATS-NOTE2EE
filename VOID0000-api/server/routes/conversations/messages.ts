import { Router } from 'express';
import {
  dmSpamGuard,
  messagesFetchLimiter,
  messagesSendLimiter,
} from '../../middleware/rate_limit.js';
import createRouter from './messages/create.js';
import historyRouter from './messages/history.js';
import typingRouter from './messages/typing.js';
import readRouter from './messages/read.js';
import byIdRouter from './messages/byId.js';

const router = Router({ mergeParams: true });
const writeGuards = Router({ mergeParams: true });
writeGuards.use(messagesSendLimiter, dmSpamGuard);

router.use((req, res, next) => {
  // Reads have their own limiter and must not count as sends or DM fanout.
  // Preserve the existing guards for every non-read method, not just creation.
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return writeGuards(req, res, next);
}, createRouter);
router.use(messagesFetchLimiter, historyRouter);
router.use(typingRouter);
router.use(readRouter);
router.use(byIdRouter);

export default router;
