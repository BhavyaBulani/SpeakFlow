import { Router } from 'express';
import { vocabularyCreateSchema } from '../../shared/schemas';
import { resolveClientOwner } from '../lib/auth';
import { ApiError, asyncHandler, routeParam } from '../lib/http';
import type { Services } from '../services';

/** Saved phrases / vocabulary for the current workspace. */
export function vocabularyRouter(services: Services): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const owner = resolveClientOwner(req);
      const items = await services.vocabulary.list(owner);
      res.json({ items });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const owner = resolveClientOwner(req);
      const input = vocabularyCreateSchema.parse(req.body ?? {});
      const item = await services.vocabulary.add(owner, input);
      res.status(201).json(item);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const owner = resolveClientOwner(req);
      const removed = await services.vocabulary.remove(owner, routeParam(req, 'id'));
      if (!removed) throw new ApiError('NOT_FOUND', { message: 'That phrase is not saved.' });
      res.status(204).end();
    }),
  );

  /** Delete all saved learning data for this workspace (privacy control). */
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const owner = resolveClientOwner(req);
      const removed = await services.vocabulary.clear(owner);
      res.json({ removed });
    }),
  );

  return router;
}
