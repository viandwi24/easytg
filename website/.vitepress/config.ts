import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const GITHUB = 'https://github.com/viandwi24/easytg';
/** Markdown files that aren't pages of the site; links to them go to GitHub. */
const OFF_SITE = ['RELEASING.md'];

export default defineConfig({
  title: 'easytg',
  description: 'Page-based Telegram bot UIs on top of grammY, with a Telegram simulator that runs in your browser.',
  // The repository is the source: README, docs/ and this website/ folder.
  srcDir: '..',
  srcExclude: ['**/node_modules/**', 'legacy/**', 'dist/**', ...OFF_SITE, 'examples/**', 'test/**', 'src/**', '.github/**'],
  rewrites: {
    'website/index.md': 'index.md',
    'website/playground.md': 'playground.md',
    'README.md': 'introduction.md',
    'CHANGELOG.md': 'changelog.md',
    'docs/README.md': 'docs/index.md',
  },
  base: process.env.DOCS_BASE ?? '/easytg/',
  cleanUrls: true,
  lastUpdated: false,
  head: [['link', { rel: 'icon', href: `${process.env.DOCS_BASE ?? '/easytg/'}logo.svg` }]],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/docs/getting-started' },
      { text: 'Playground', link: '/playground' },
      { text: 'API', link: '/docs/app' },
      { text: 'Changelog', link: '/changelog' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is easytg?', link: '/introduction' },
          { text: 'Getting started', link: '/docs/getting-started' },
          { text: 'Playground', link: '/playground' },
          { text: 'Documentation index', link: '/docs/' },
        ],
      },
      {
        text: 'Building the UI',
        items: [
          { text: 'Pages', link: '/docs/pages' },
          { text: 'Media', link: '/docs/media' },
          { text: 'Main menu', link: '/docs/menu' },
          { text: 'Commands', link: '/docs/commands' },
          { text: 'Flow map', link: '/docs/flowchart' },
          { text: 'Dialogues', link: '/docs/dialogues' },
          { text: 'Text input', link: '/docs/text-input' },
          { text: 'Text formatting', link: '/docs/formatting' },
          { text: 'Rich messages', link: '/docs/rich-messages' },
          { text: 'Languages', link: '/docs/i18n' },
          { text: 'Inline mode', link: '/docs/inline-mode' },
          { text: 'Mini Apps', link: '/docs/mini-apps' },
          { text: 'Groups', link: '/docs/groups' },
          { text: 'Streaming', link: '/docs/streaming' },
        ],
      },
      {
        text: 'State and data',
        items: [
          { text: 'Sessions', link: '/docs/sessions' },
          { text: 'Storage', link: '/docs/storage' },
          { text: 'Button params', link: '/docs/button-params' },
          { text: 'Deep links', link: '/docs/deep-links' },
        ],
      },
      {
        text: 'Beyond a single update',
        items: [
          { text: 'Sending without an update', link: '/docs/proactive' },
          { text: 'Relays', link: '/docs/relay' },
          { text: 'Scheduled tasks', link: '/docs/scheduler' },
          { text: 'Queues', link: '/docs/queues' },
          { text: 'Payments', link: '/docs/payments' },
        ],
      },
      {
        text: 'Running in production',
        items: [
          { text: 'Anti-spam', link: '/docs/anti-spam' },
          { text: 'Scaling', link: '/docs/scaling' },
          { text: 'Serverless and edge', link: '/docs/serverless' },
          { text: 'Security notes', link: '/docs/security' },
          { text: 'Events', link: '/docs/events' },
          { text: 'Error helpers', link: '/docs/errors' },
          { text: 'Options', link: '/docs/options' },
          { text: 'API reference', link: '/docs/app' },
          { text: 'Testing', link: '/docs/testing' },
          { text: 'Preview and recorded tests', link: '/docs/preview' },
          { text: 'Simulator', link: '/docs/simulator' },
          { text: 'Migrating', link: '/docs/migration' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: GITHUB },
      { icon: 'npm', link: 'https://www.npmjs.com/package/easytg' },
    ],
    editLink: { pattern: `${GITHUB}/edit/main/:path`, text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    footer: { message: 'MIT licensed', copyright: 'easytg' },
    outline: { level: [2, 3] },
  },
  markdown: {
    config(md) {
      // Links to source files (examples, src, LICENSE, …) go to GitHub; pages stay on the site.
      md.core.ruler.after('inline', 'easytg-source-links', (state) => {
        const source = (state.env as { path?: string }).path;
        if (!source) return;
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            if (token.type !== 'link_open') continue;
            const href = token.attrGet('href');
            if (!href || /^([a-z]+:|#|\/)/i.test(href)) continue;
            const [path, hash] = href.split('#');
            if (!path) continue;
            const target = relative(root, join(dirname(source), path));
            if (target.startsWith('..') || (path.endsWith('.md') && !OFF_SITE.includes(target))) continue;
            const kind = existsSync(join(root, target)) && !target.includes('.') ? 'tree' : 'blob';
            token.attrSet('href', `${GITHUB}/${kind}/main/${target}${hash ? `#${hash}` : ''}`);
          }
        }
      });
      // ```ts playground  →  an editor with a live Telegram simulator.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index]!;
        const info = token.info.trim().split(/\s+/);
        if (!info.includes('playground')) return fence(tokens, index, options, env, self);
        const start = /start="([^"]*)"/.exec(token.info)?.[1];
        const attrs = [`code="${encodeURIComponent(token.content)}"`];
        if (start !== undefined) attrs.push(`start="${md.utils.escapeHtml(start)}"`);
        if (info.includes('group')) attrs.push('group');
        if (info.includes('users')) attrs.push('users');
        if (info.includes('limits')) attrs.push('limits');
        return `<ClientOnly><Playground ${attrs.join(' ')} /></ClientOnly>\n`;
      };
    },
  },
  vite: {
    // srcDir is the repository, but the static files live here.
    publicDir: resolve(here, '../public'),
    resolve: {
      alias: [
        { find: /^easytg$/, replacement: resolve(root, 'src/index.ts') },
        { find: /^easytg\/(.*)$/, replacement: resolve(root, 'src/$1') },
      ],
    },
    plugins: [
      {
        // Browsers have no AsyncLocalStorage: easytg's browser build swaps this module, so do we.
        name: 'easytg-browser-platform',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source.endsWith('/platform/context') && importer?.startsWith(resolve(root, 'src'))) {
            return resolve(root, 'src/platform/context.browser.ts');
          }
          return null;
        },
      },
    ],
    server: { fs: { allow: [root] } },
  },
});
