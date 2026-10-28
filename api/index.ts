/**
 * Vercel serverless entry.
 *
 * Deliberately three lines: the Express app is built in
 * `src/server/serverless.ts`, where it can be imported and tested. This file
 * exists only because Vercel discovers handlers under `api/`.
 */
import handler from '../src/server/serverless';

export default handler;
