import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof ZodError) {
    return c.json(
      { error: 'Validation échouée', issues: err.flatten().fieldErrors },
      400,
    );
  }

  logger.error({ err }, 'Erreur non gérée');
  return c.json({ error: 'Erreur interne du serveur' }, 500);
};
