/**
 * Vercel serverless entry.
 *
 * Plain JavaScript on purpose. It imports the **built** app from
 * `dist/server/serverless.js` rather than the TypeScript source, because
 * Vercel's TypeScript step compiles this file on its own and leaves relative
 * specifiers exactly as written: `../src/server/serverless` reached `/var/task`
 * as an extensionless path Node's ESM resolver cannot resolve, and every
 * invocation died with ERR_MODULE_NOT_FOUND before the handler ran (the SPA
 * served fine; only `/api/*` failed).
 *
 * A `.js` entry also keeps Vercel from type-checking this shim, which has no
 * declarations to find for a bundled output. The real app is type-checked and
 * tested through `src/server/serverless.ts` (`tests/serverless.test.ts`).
 */
import handler from '../dist/server/serverless.js';

export default handler;
