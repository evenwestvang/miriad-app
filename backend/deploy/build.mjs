/**
 * Build script for Lambda deployment
 *
 * Bundles the server code into a single file for Lambda.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  console.log('Building Lambda bundles...');

  const commonOptions = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: [],
    minify: true,
    sourcemap: true,
    banner: {
      js: `
        import { createRequire } from 'module';
        const require = createRequire(import.meta.url);
      `.trim(),
    },
  };

  // Build main API Lambda
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'lambda.ts')],
    outfile: join(__dirname, 'dist', 'lambda.mjs'),
  });
  console.log('Build complete: deploy/dist/lambda.mjs');

  // Build WebSocket handlers Lambda
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'websocket-handlers.ts')],
    outfile: join(__dirname, 'dist', 'websocket-handlers.mjs'),
  });
  console.log('Build complete: deploy/dist/websocket-handlers.mjs');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
