/**
 * Builds dist/ (Node, Bun, Deno) and dist/browser/ (browsers and the docs
 * playground), then the type declarations.
 *
 *   bun run build
 */
import { $, type BunPlugin } from 'bun';
import { rm } from 'node:fs/promises';

const entrypoints = ['./src/index.ts', './src/testing.ts', './src/simulator/index.ts', './src/simulator/element.ts'];
/** Server runtimes only (they read files and patch grammY's fetch). The CLI runs from src/ with Bun. */
const serverOnly = ['./src/simulator/load.ts'];

/** Browsers have no AsyncLocalStorage: use platform/context.browser.ts instead. */
const browserPlatform: BunPlugin = {
  name: 'easytg-browser-platform',
  setup(build) {
    build.onResolve({ filter: /\/platform\/context$/ }, (args) => ({
      path: new URL('../src/platform/context.browser.ts', import.meta.url).pathname,
    }));
  },
};

await rm('dist', { recursive: true, force: true });

const builds = [
  Bun.build({ entrypoints: [...entrypoints, ...serverOnly], outdir: 'dist', root: './src', target: 'node', packages: 'external' }),
  Bun.build({ entrypoints, outdir: 'dist/browser', root: './src', target: 'browser', packages: 'external', plugins: [browserPlatform] }),
];
for (const result of await Promise.all(builds)) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

// Nothing Node-only may be left in the browser build.
for (const file of new Bun.Glob('dist/browser/**/*.js').scanSync()) {
  const code = await Bun.file(file).text();
  const leak = code.match(/from\s*["']node:[^"']+["']|require\(["']node:/);
  if (leak) {
    console.error(`${file} still imports ${leak[0]}`);
    process.exit(1);
  }
}

await $`tsc -p tsconfig.build.json`;
console.log('built dist/ and dist/browser/');
