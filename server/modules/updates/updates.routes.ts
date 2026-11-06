import express from 'express';

import { createUpdatesService } from './updates.service.js';

/** Updates module tests and composition use this transport-only router. */
export function createUpdatesRouter(service: ReturnType<typeof createUpdatesService>): express.Router {
  const router = express.Router();
  router.get('/', async (request, response) => {
    const force = request.query.force === '1' || request.query.force === 'true';
    response.json(await service.check({ force }));
  });
  router.put('/channel', async (request, response) => {
    const channel: unknown = request.body?.channel;
    if (channel !== 'stable' && channel !== 'beta') {
      response.status(400).json({ error: 'Invalid release channel' });
      return;
    }
    response.json(await service.setChannel(channel));
  });
  router.post('/apply', async (_request, response) => {
    try {
      response.status(202).json(await service.apply());
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
