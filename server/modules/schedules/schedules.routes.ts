import express from 'express';
import type { Request, Response } from 'express';

import { triggerScheduleRunNow } from '@/modules/schedules/services/schedule-scheduler.service.js';
import { schedulesService } from '@/modules/schedules/services/schedules.service.js';
import type { LLMProvider, ScheduleWriteInput } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const PROVIDERS: readonly LLMProvider[] = ['claude', 'codex', 'opencode'];

function badRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
}

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', { code: 'USER_REQUIRED', statusCode: 401 });
  }
  return userId;
}

function readId(request: Request): string {
  const id = request.params.id;
  if (typeof id !== 'string' || !id.trim()) throw badRequest('id is required.');
  return id;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  return value;
}

function optionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === null) return null;
  return optionalString(body, field);
}

/** Turns a create/update body into the service's typed input; content rules are the service's. */
function readScheduleInput(rawBody: unknown): ScheduleWriteInput {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw badRequest('Request body must be an object.');
  }
  const body = rawBody as Record<string, unknown>;

  const provider = optionalString(body, 'provider');
  if (provider !== undefined && !PROVIDERS.includes(provider as LLMProvider)) {
    throw new AppError(`Unsupported provider "${provider}".`, { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
  }
  const kind = optionalString(body, 'kind');
  if (kind !== undefined && kind !== 'once' && kind !== 'cron') {
    throw badRequest('kind must be "once" or "cron".');
  }
  const maxDuration = body.maxDurationMinutes;
  if (maxDuration !== undefined && typeof maxDuration !== 'number') {
    throw badRequest('maxDurationMinutes must be a number.');
  }
  const enabled = body.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean.');
  }

  return {
    name: optionalString(body, 'name'),
    projectId: optionalString(body, 'projectId'),
    provider: provider as LLMProvider | undefined,
    model: optionalNullableString(body, 'model'),
    effort: optionalNullableString(body, 'effort'),
    permissionMode: optionalString(body, 'permissionMode'),
    prompt: optionalString(body, 'prompt'),
    kind: kind as ScheduleWriteInput['kind'],
    cronExpression: optionalNullableString(body, 'cronExpression'),
    runAt: optionalNullableString(body, 'runAt'),
    timezone: optionalString(body, 'timezone'),
    maxDurationMinutes: maxDuration as number | undefined,
    enabled: enabled as boolean | undefined,
  };
}

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    res.json(createApiSuccessResponse(schedulesService.list(readUserId(req), projectId)));
  }),
);

router.post(
  '/preview',
  asyncHandler(async (req: Request, res: Response) => {
    readUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cron = optionalString(body, 'cron');
    if (!cron) throw badRequest('cron is required.');
    const timezone = optionalString(body, 'timezone') ?? 'UTC';
    res.json(createApiSuccessResponse({ nextRuns: schedulesService.preview(cron, timezone) }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const schedule = schedulesService.create(readUserId(req), readScheduleInput(req.body));
    res.status(201).json(createApiSuccessResponse(schedule));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(schedulesService.get(readUserId(req), readId(req))));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      schedulesService.update(readUserId(req), readId(req), readScheduleInput(req.body)),
    ));
  }),
);

router.post(
  '/:id/pause',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(schedulesService.pause(readUserId(req), readId(req))));
  }),
);

router.post(
  '/:id/resume',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(schedulesService.resume(readUserId(req), readId(req))));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    schedulesService.delete(readUserId(req), readId(req));
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

router.post(
  '/:id/run-now',
  asyncHandler(async (req: Request, res: Response) => {
    triggerScheduleRunNow(readUserId(req), readId(req));
    res.status(202).json(createApiSuccessResponse({ queued: true }));
  }),
);

router.get(
  '/:id/runs',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(schedulesService.listRuns(readUserId(req), readId(req))));
  }),
);

export default router;
