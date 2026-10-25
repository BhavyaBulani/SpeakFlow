import { build } from 'esbuild';

/**
 * Bundles the Express server into a single ESM file for production.
 *
 * We bundle (rather than `tsc` emit) so that the server and the browser client
 * can share `src/shared/**` using plain extensionless TypeScript imports with
 * one tsconfig. Node built-ins and node_modules stay external, so runtime
 * dependencies must still be installed in the deploy environment.
 */
const result = await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
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
});

if (result.errors.length > 0) {
  console.error(result.errors);
  process.exit(1);
}
console.log('server bundle written to dist/server/index.js');
