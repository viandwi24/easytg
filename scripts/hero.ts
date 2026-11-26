/**
 * Draws the README's hero image: the bot in scripts/hero/bot.ts next to the
 * chat it makes, run against the simulator in a headless browser.
 *
 *   bun run hero
 *
 * Writes .github/assets/hero-dark.png and hero-light.png. Needs a Chromium
 * browser (Chrome, Brave, Edge or Chromium); set CHROME to its path if it
 * isn't found.
 */
import type { BunPlugin } from 'bun';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeToHtml } from 'shiki';

const root = join(import.meta.dir, '..');
const hero = join(root, 'scripts/hero');
const out = join(root, '.github/assets');
const WIDTH = 1280;
const HEIGHT = 1056;

/** bot.ts imports `grammy` and `easytg` like any bot: the page's versions. */
const heroImports: BunPlugin = {
  name: 'easytg-hero',
  setup(build) {
    build.onResolve({ filter: /^grammy$/ }, (args) => (args.importer.endsWith('/hero/bot.ts') ? { path: join(hero, 'grammy.ts') } : undefined));
    build.onResolve({ filter: /^easytg$/ }, () => ({ path: join(root, 'src/index.ts') }));
    build.onResolve({ filter: /\/platform\/context$/ }, () => ({ path: join(root, 'src/platform/context.browser.ts') }));
  },
};

const built = await Bun.build({ entrypoints: [join(hero, 'client.ts')], target: 'browser', format: 'esm', minify: true, plugins: [heroImports] });
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const script = (await built.outputs[0]!.text()).replaceAll('</script', '<\\/script');
const source = (await Bun.file(join(hero, 'bot.ts')).text()).trimEnd();
/** Edmi UI's tokens (warm neutrals, Instrument Sans, mono labels): github.com/viandwi24/edmi-ui. */
function page(theme: 'dark' | 'light', code: string) {
  return `<!doctype html>
<html data-theme="${theme}"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --background: oklch(0.964 0.005 95.1); --foreground: oklch(0.239 0.004 106.7); --card: oklch(1 0 0);
  --muted: oklch(0.973 0.005 95.1); --muted-foreground: oklch(0.575 0.008 97.4); --border: oklch(0.909 0.010 93.6);
  --card-hi: #fff; --brand-soft: oklch(0.953 0.022 151.6); --brand-text: oklch(0.526 0.122 147.7);
  --float: 0 1px 2px rgba(0,0,0,.04), 0 18px 40px -18px rgba(40,36,28,.18);
}
[data-theme=dark] {
  --background: oklch(0.183 0.004 286.0); --foreground: oklch(0.944 0.003 286.3); --card: oklch(0.228 0.008 285.8);
  --muted: oklch(0.206 0.008 285.7); --muted-foreground: oklch(0.692 0.012 286.1); --border: oklch(0.312 0.011 285.8);
  --card-hi: rgba(255,255,255,.035); --brand-soft: oklch(0.29 0.05 151); --brand-text: oklch(0.78 0.12 150);
  --float: 0 8px 24px rgba(0,0,0,.5);
}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
body { background: var(--background); color: var(--foreground); font-family: 'Instrument Sans', system-ui, sans-serif; padding: 40px 64px; }
header { text-align: center; }
.eyebrow { font-size: 14px; letter-spacing: .04em; color: var(--muted-foreground); font-weight: 500; }
h1 { margin-top: 14px; font-size: 50px; line-height: 1.04; letter-spacing: -.035em; font-weight: 500; }
header p { margin-top: 16px; font-size: 18px; line-height: 1.5; color: var(--muted-foreground); }
main { display: grid; grid-template-columns: 1fr 372px; gap: 32px; margin-top: 40px; }
.label { font: 500 11px 'JetBrains Mono', monospace; letter-spacing: .18em; text-transform: uppercase; color: var(--muted-foreground); margin: 0 0 10px 4px; }
.panel { height: 730px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: inset 0 1px 0 var(--card-hi), var(--float); overflow: hidden; display: flex; flex-direction: column; }
.head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground); }
.head b { font: 500 12.5px 'JetBrains Mono', monospace; color: var(--foreground); }
.head .tag { margin-left: auto; font-size: 12px; font-weight: 500; padding: 2px 9px; border-radius: 6px; background: var(--brand-soft); color: var(--brand-text); }
.code pre { background: transparent !important; padding: 16px 20px; font: 12.8px/1.6 'JetBrains Mono', ui-monospace, monospace; }
.code .line::before { counter-increment: line; content: counter(line); display: inline-block; width: 22px; margin-right: 18px; text-align: right; color: var(--muted-foreground); opacity: .5; }
.code code { counter-reset: line; }
#chat { flex: 1; min-height: 0; }
#chat easytg-chat { height: 100%; display: block; }
</style></head>
<body>
<header>
  <div class="eyebrow">easytg · Telegram bot interfaces on grammY</div>
  <h1>Write Telegram bots as pages,<br>not message handlers</h1>
  <p>Describe each screen once: easytg sends it, edits it in place and answers the buttons.</p>
</header>
<main>
  <div><div class="label">The code</div><section class="panel code"><div class="head"><b>bot.ts</b><span class="tag">easytg + grammY</span></div>${code}</section></div>
  <div><div class="label">What it does</div><section class="panel"><div class="head"><b>@easytg/simulator</b><span class="tag">no token</span></div><div id="chat"></div></section></div>
</main>
<script type="module">${script}</script>
</body></html>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('No Chromium browser found: set CHROME to its path');
  return found;
}

const chrome = findChrome();
const dir = mkdtempSync(join(tmpdir(), 'easytg-hero-'));
for (const theme of ['dark', 'light'] as const) {
  const code = await codeToHtml(source, { lang: 'ts', theme: theme === 'dark' ? 'vitesse-dark' : 'vitesse-light' });
  const html = join(dir, `${theme}.html`);
  writeFileSync(html, page(theme, code));
  const png = join(out, `hero-${theme}.png`);
  // The page plays a short conversation; virtual time lets it finish before the shot.
  const proc = Bun.spawn(
    [chrome, '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${WIDTH},${HEIGHT}`, '--virtual-time-budget=30000', `--screenshot=${png}`, `file://${html}`],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  await proc.exited;
  console.log(`Wrote ${png} (page: ${html})`);
}
