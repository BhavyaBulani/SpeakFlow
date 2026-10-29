/**
 * Vercel serverless entry.
 *
 * Imports the **bundled** app from `dist/server/serverless.js`, not
 * `src/server/serverless.ts`. Vercel's TypeScript step compiles this file on its
 * own and keeps relative specifiers exactly as written, so `../src/server/
 * serverless` reached `/var/task` as an extensionless path that Node's ESM
 * resolver cannot resolve, and every invocation died with ERR_MODULE_NOT_FOUND
 * before the handler ran (the SPA served fine, only `/api/*` failed). Pointing
 * at the esbuild output — which `npm run build:server` emits and `vercel.json`
 * builds before packaging this function — keeps the entry one line and leaves
 * the extensionless-import convention to esbuild, which resolves it correctly.
 *
 * `api/` is outside tsconfig's `include`, so this specifier is not typechecked;
 * the real app is tested through `src/server/serverless.ts` in
 * `tests/serverless.test.ts`.
 */
import handler from '../dist/server/serverless.js';

export default handler;
