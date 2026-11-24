/**
 * Builds each package's dist/ (Node, Bun, Deno) and dist/browser/ (browsers
 * and the docs playground), then its type declarations: first
 * packages/simulator (@easytg/simulator), then easytg, which imports it.
 *
 *   bun run build
 */
import { $, type BunPlugin } from 'bun';
import { rm } from 'node:fs/promises';

/** Browsers have no AsyncLocalStorage: use platform/context.browser.ts instead. */
const browserPlatform: BunPlugin = {
  name: 'easytg-browser-platform',
  setup(build) {
    build.onResolve({ filter: /\/platform\/context$/ }, (args) => ({
      path: new URL('../src/platform/context.browser.ts', import.meta.url).pathname,
    }));
  },
};

/** The workspace packages stay imports: tsconfig's paths would otherwise inline them. */
const workspaceExternal: BunPlugin = {
  name: 'easytg-workspace-external',
  setup(build) {
    build.onResolve({ filter: /^@easytg\/simulator(\/.*)?$/ }, (args) => ({ path: args.path, external: true }));
  },
};

interface Package {
  /** The package's folder, relative to the repository. */
  dir: string;
  entrypoints: string[];
  /** Server runtimes only (they read files or patch grammY's fetch). */
  serverOnly: string[];
  plugins: BunPlugin[];
}

const PACKAGES: Package[] = [
  {
    dir: 'packages/simulator',
    entrypoints: ['src/index.ts', 'src/element.ts'],
    serverOnly: ['src/load.ts'],
    plugins: [],
  },
  {
    dir: '.',
    entrypoints: ['src/index.ts', 'src/testing.ts', 'src/simulator/index.ts', 'src/simulator/element.ts'],
    // The CLI runs from src/ with Bun.
    serverOnly: ['src/simulator/load.ts'],
    plugins: [browserPlatform],
  },
];

async function build(pkg: Package) {
  const at = (file: string) => `${pkg.dir}/${file}`;
  const out = at('dist');
  await rm(out, { recursive: true, force: true });
  const entrypoints = pkg.entrypoints.map(at);
  const builds = [
    Bun.build({ entrypoints: [...entrypoints, ...pkg.serverOnly.map(at)], outdir: out, root: at('src'), target: 'node', packages: 'external', plugins: [workspaceExternal] }),
    Bun.build({ entrypoints, outdir: `${out}/browser`, root: at('src'), target: 'browser', packages: 'external', plugins: [workspaceExternal, ...pkg.plugins] }),
  ];
  for (const result of await Promise.all(builds)) {
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      process.exit(1);
    }
  }

  // Nothing Node-only may be left in the browser build.
  for (const file of new Bun.Glob(`${out}/browser/**/*.js`).scanSync()) {
    const code = await Bun.file(file).text();
    const leak = code.match(/from\s*["']node:[^"']+["']|require\(["']node:/);
    if (leak) {
      console.error(`${file} still imports ${leak[0]}`);
      process.exit(1);
    }
  }

  await $`tsc -p ${at('tsconfig.build.json')}`;
  console.log(`built ${out}/ and ${out}/browser/`);
}

for (const pkg of PACKAGES) await build(pkg);
