import { build } from 'esbuild';

/**
 * Bundles the Express server into single ESM files for production.
 *
 * We bundle (rather than `tsc` emit) so that the server and the browser client
 * can share `src/shared/**` using plain extensionless TypeScript imports with
 * one tsconfig. Node built-ins and node_modules stay external, so runtime
 * dependencies must still be installed in the deploy environment.
 *
 * Two entries, because the two topologies start the app differently
 * (docs/DEPLOYMENT.md):
 *
 *  - `dist/server/index.js`      long-running server (Render): binds a port and
 *                                serves the SPA. `npm start` runs this.
 *  - `dist/server/serverless.js` Vercel function: no port, no static serving.
 *                                `api/index.ts` imports *this bundle*, because
 *                                Vercel's own TypeScript compiles `api/index.ts`
 *                                alone and leaves relative specifiers pointing
 *                                at `.ts` files that never reach `/var/task`.
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __speakflowCreateRequire } from 'node:module';",
      'const require = __speakflowCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  metafile: false,
};

const entries = [
  { entryPoints: ['src/server/index.ts'], outfile: 'dist/server/index.js' },
  { entryPoints: ['src/server/serverless.ts'], outfile: 'dist/server/serverless.js' },
];

let failed = false;
for (const entry of entries) {
  const result = await build({ ...shared, ...entry });
  if (result.errors.length > 0) {
    console.error(result.errors);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('server bundles written to dist/server/ (index.js + serverless.js)');
