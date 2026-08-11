import { Router } from 'express';

export function createApiStatusRouter({ monitor, logger = console, now = () => new Date() }) {
  if (!monitor || typeof monitor.getSnapshot !== 'function') {
    throw new TypeError('A status monitor with getSnapshot() is required.');
  }

  const router = Router();

  router.get('/status', async (_req, res) => {
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
    });

    try {
      res.status(200).json(await monitor.getSnapshot());
    } catch (error) {
      logger.error?.('API status snapshot failed:', error);
      res.set('Retry-After', '10');
      res.status(503).json({
        error: {
          code: 'STATUS_CHECK_FAILED',
          message: 'Live status is temporarily unavailable.',
        },
        checkedAt: now().toISOString(),
        retryAfterMs: 10_000,
      });
    }
  });

  return router;
}
