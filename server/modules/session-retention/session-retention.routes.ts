import express from 'express';
import type { Request, Response } from 'express';

import type { SessionRetentionSettings } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { createSessionRetentionService } from './session-retention.service.js';

const MAX_INACTIVE_DAYS = 3650;

function invalidSettings(message: string): AppError {
  return new AppError(message, { code: 'INVALID_SESSION_RETENTION_SETTINGS', statusCode: 400 });
}

/**
 * Validates a settings patch. Every field is optional, but a field that is
 * present must be valid: a typo must fail loudly rather than silently leave
 * deletion configured the way it was.
 */
function parseSettingsPatch(body: unknown): Partial<SessionRetentionSettings> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidSettings('Request body must be an object.');
  }
  const input = body as Record<string, unknown>;
  const patch: Partial<SessionRetentionSettings> = {};

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw invalidSettings('enabled must be a boolean.');
    patch.enabled = input.enabled;
  }
  if (input.inactiveDays !== undefined) {
    const days = input.inactiveDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_INACTIVE_DAYS) {
      throw invalidSettings(`inactiveDays must be a whole number between 1 and ${MAX_INACTIVE_DAYS}.`);
    }
    patch.inactiveDays = days;
  }
  if (input.action !== undefined) {
    if (input.action !== 'archive' && input.action !== 'delete') {
      throw invalidSettings('action must be "archive" or "delete".');
    }
    patch.action = input.action;
  }
  if (input.skipStarredProjects !== undefined) {
    if (typeof input.skipStarredProjects !== 'boolean') {
      throw invalidSettings('skipStarredProjects must be a boolean.');
    }
    patch.skipStarredProjects = input.skipStarredProjects;
  }
  if (input.autoTitleSessions !== undefined) {
    if (typeof input.autoTitleSessions !== 'boolean') throw invalidSettings('autoTitleSessions must be a boolean.');
    patch.autoTitleSessions = input.autoTitleSessions;
  }
  return patch;
}

/**
 * Creates the thin transport for the inactive-session cleanup.
 *
 * Used by this module's composition root, and by its route tests with a fake
 * service.
 */
export function createSessionRetentionRouter(
  service: ReturnType<typeof createSessionRetentionService>,
): express.Router {
  const router = express.Router();

  router.get('/settings', asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(service.getStatus()));
  }));

  router.put('/settings', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(service.updateSettings(parseSettingsPatch(req.body))));
  }));

  router.get('/preview', asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.preview()));
  }));

  router.post('/run', asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.runNow()));
  }));

  return router;
}
