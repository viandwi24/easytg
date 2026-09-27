/**
 * Release in one command: bump, changelog, checks, commit, tag, push.
 * Pushing the tag triggers .github/workflows/release.yml, which publishes to
 * npm and creates the GitHub release.
 *
 *   bun run release patch            0.1.0 -> 0.1.1
 *   bun run release minor            0.1.0 -> 0.2.0
 *   bun run release major            0.1.0 -> 1.0.0
 *   bun run release 0.2.0-beta.1     explicit version (prereleases publish under the "next" tag)
 *
 * Flags:
 *   --dry-run   show what would happen, change nothing
 *   --no-push   only bump, date the changelog and commit + tag locally
 *   --yes       don't ask for confirmation before pushing
 *
 * Needs a clean working tree on the main branch.
 */
import { $ } from 'bun';

const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const push = !args.includes('--no-push');
const assumeYes = args.includes('--yes');
const MAIN_BRANCH = 'main';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message: string) {
  console.log(`→ ${message}`);
}

function nextVersion(current: string, bump: string | undefined): string {
  if (!bump) fail('Usage: bun run release <patch|minor|major|x.y.z> [--dry-run] [--no-push] [--yes]');
  if (SEMVER.test(bump)) return bump;
  const match = SEMVER.exec(current);
  if (!match) fail(`Current version "${current}" is not semver`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  switch (bump) {
    case 'patch':
      return match[4] !== undefined ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      fail(`Unknown bump "${bump}": use patch, minor, major or an explicit version like 1.2.3`);
  }
}

function compare(a: string, b: string): number {
  const pa = SEMVER.exec(a)!;
  const pb = SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return diff;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1; // 1.0.0 > 1.0.0-beta
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/** Output of a git command, or '' if it failed. */
const git = async (strings: TemplateStringsArray, ...values: string[]) =>
  (await $(strings, ...values).quiet().nothrow().text()).trim();

/** Run a check quietly; on failure show its output and stop. */
async function check(name: string, command: ReturnType<typeof $>) {
  const result = await command.quiet().nothrow();
  if (result.exitCode !== 0) {
    console.error(result.stdout.toString() + result.stderr.toString());
    fail(`${name} failed: nothing was changed`);
  }
}

// ---- what to release ----------------------------------------------------------

const pkgText = await Bun.file('package.json').text();
const current = (JSON.parse(pkgText) as { version: string }).version;
const version = nextVersion(current, bump);
const tag = `v${version}`;
const prerelease = version.includes('-');
if (compare(version, current) < 0) fail(`${version} is lower than the current version ${current}`);

const changelog = await Bun.file('CHANGELOG.md').text();
const unreleased = /^## Unreleased[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased) fail('CHANGELOG.md has no "## Unreleased" section');
const notes = unreleased[1]!.trim();
if (!notes) fail('The "## Unreleased" section of CHANGELOG.md is empty: describe the changes first');

// ---- preflight: fail before touching anything ------------------------------

if ((await git`git rev-parse --is-inside-work-tree`) !== 'true') fail('Not inside a git repository');
if (await git`git status --porcelain`) fail('The working tree has uncommitted changes: commit or stash them first');
const branch = await git`git rev-parse --abbrev-ref HEAD`;
if (branch !== MAIN_BRANCH) fail(`Releases are made from "${MAIN_BRANCH}", but you are on "${branch}"`);
if (await git`git tag --list ${tag}`) fail(`Tag ${tag} already exists`);

let repo: string | undefined; // "owner/name" on GitHub
if (push) {
  const remote = await git`git remote get-url origin`;
  if (!remote) fail('No "origin" remote to push to (use --no-push to release locally)');
  repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1];

  step('Checking that the branch is up to date with origin');
  await $`git fetch --quiet --tags origin`.quiet().nothrow();
  const behind = await git`git rev-list --count HEAD..origin/${MAIN_BRANCH}`;
  if (behind && behind !== '0') fail(`"${MAIN_BRANCH}" is ${behind} commit(s) behind origin: pull first`);
  if (await git`git ls-remote --tags origin refs/tags/${tag}`) fail(`Tag ${tag} already exists on origin`);
}

console.log(`
Release ${current} -> ${version}${prerelease ? ' (prerelease, npm tag "next")' : ''}

${notes}
`);
console.log('Plan:');
console.log('  1. typecheck, test, build');
console.log(`  2. update package.json and CHANGELOG.md, commit "release: ${tag}", tag ${tag}`);
if (push) {
  console.log(`  3. push ${MAIN_BRANCH} and ${tag}: GitHub Actions publishes to npm and creates the GitHub release`);
}

if (dryRun) {
  console.log('\nDry run: nothing changed.');
  process.exit(0);
}

// ---- do it ---------------------------------------------------------------------

step('Running typecheck, tests and build');
await check('Typecheck', $`bun run typecheck`);
await check('Tests', $`bun test`);
await check('Build', $`bun run build`);

const date = new Date().toISOString().slice(0, 10);
const newChangelog = changelog.replace(unreleased[0], () => `## Unreleased\n\n## ${version} (${date})\n\n${notes}\n\n`);
await Bun.write('package.json', pkgText.replace(`"version": "${current}"`, () => `"version": "${version}"`));
await Bun.write('CHANGELOG.md', newChangelog);

step(`Committing and tagging ${tag}`);
await $`git add package.json CHANGELOG.md`.quiet();
await $`git commit --quiet -m ${`release: ${tag}`}`;
await $`git tag -a ${tag} -m ${tag}`;

const undo = `git tag -d ${tag} && git reset --hard HEAD~1`;

if (!push) {
  console.log(`\n✓ ${tag} committed and tagged locally. To release it: git push --atomic origin ${MAIN_BRANCH} ${tag}`);
  process.exit(0);
}

if (!assumeYes) {
  const answer = prompt(`\nPush ${tag} and publish easytg@${version} to npm? [y/N]`);
  if (answer?.trim().toLowerCase() !== 'y') {
    console.log(`\nStopped before pushing. The commit and tag are local; to undo them:\n  ${undo}`);
    process.exit(0);
  }
}

step(`Pushing ${MAIN_BRANCH} and ${tag}`);
const pushed = await $`git push --atomic origin ${MAIN_BRANCH} ${tag}`.nothrow();
if (pushed.exitCode !== 0) fail(`Push failed; nothing was published. To undo the local commit and tag:\n  ${undo}`);

const repoUrl = repo ? `https://github.com/${repo}` : undefined;
console.log(`
✓ Pushed ${tag}. GitHub Actions now publishes easytg@${version} to npm and creates the release:
  ${repoUrl ? `${repoUrl}/actions/workflows/release.yml` : 'see the Actions tab on GitHub'}
  https://www.npmjs.com/package/easytg`);
