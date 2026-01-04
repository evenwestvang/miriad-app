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
  console.log('Building Lambda bundle...');

  await esbuild.build({
    entryPoints: [join(__dirname, 'lambda.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: join(__dirname, 'dist', 'lambda.mjs'),
    external: [],
    minify: true,
    sourcemap: true,
    banner: {
      js: `
        import { createRequire } from 'module';
        const require = createRequire(import.meta.url);
      `.trim(),
    },
  });

  console.log('Build complete: deploy/dist/lambda.mjs');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
