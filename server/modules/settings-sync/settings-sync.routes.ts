import express from 'express';

import type { createSettingsSyncService } from './settings-sync.service.js';

type Authenticated = express.Request & { user?: { id?: number | string } };

/** Thin authenticated transport for Settings Sync operations. */
export function createSettingsSyncRouter(service: ReturnType<typeof createSettingsSyncService>): express.Router {
  const router = express.Router();
  const respond = (handler: (req: express.Request) => unknown | Promise<unknown>) => async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try { res.json(await handler(req)); } catch (error) { next(error); }
  };
  const userId = (req: express.Request) => Number((req as Authenticated).user?.id);
  router.get('/config', respond(() => service.getConfig()));
  router.put('/config', respond((req) => service.saveConfig(req.body)));
  router.delete('/config', respond(() => service.deleteConfig()));
  router.post('/push', respond((req) => service.push(userId(req), req.body?.client)));
  router.post('/pull', respond((req) => service.pull(userId(req))));
  return router;
}
