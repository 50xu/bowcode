import express from 'express';

import { createUpdatesService } from './updates.service.js';

/** Updates module tests and composition use this transport-only router. */
export function createUpdatesRouter(service: ReturnType<typeof createUpdatesService>): express.Router {
  const router = express.Router();
  router.get('/', async (request, response) => {
    const force = request.query.force === '1' || request.query.force === 'true';
    response.json(await service.check({ force }));
  });
  router.post('/apply', (_request, response) => {
    try {
      response.status(202).json(service.apply());
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
