import { Router } from 'express';
import { translateRequestSchema } from '../../shared/schemas';
import { asyncHandler } from '../lib/http';
import type { Services } from '../services';
import { translateToEnglish } from '../services/translation';

/** Hindi / Hinglish / rough English -> natural spoken English. */
export function translateRouter(services: Services): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = translateRequestSchema.parse(req.body ?? {});

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const result = await translateToEnglish(services, {
        text: input.text,
        targetTone: input.targetTone,
        sourceLanguage: input.sourceLanguage,
        signal: controller.signal,
      });

      res.json(result);
    }),
  );

  return router;
}
