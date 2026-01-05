/**
 * Build script for Lambda deployment
 *
 * Bundles the server code into single files for Lambda.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sharedConfig = {
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

async function build() {
  console.log('Building Lambda bundles...');

  // Build main API Lambda
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [join(__dirname, 'lambda.ts')],
    outfile: join(__dirname, 'dist', 'lambda.mjs'),
  });
  console.log('  - dist/lambda.mjs');

  // Build WebSocket handlers Lambda
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [join(__dirname, 'websocket-handlers.ts')],
    outfile: join(__dirname, 'dist', 'websocket-handlers.mjs'),
  });
  console.log('  - dist/websocket-handlers.mjs');

  console.log('Build complete!');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
