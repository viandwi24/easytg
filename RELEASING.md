# Releasing

Pushing a version tag (`v1.2.3`) is all it takes. GitHub Actions then
publishes to npm and creates the GitHub release. Nobody publishes from a
laptop, and every version gets npm
[provenance](https://docs.npmjs.com/generating-provenance-statements).

## Every release

While working, describe changes under `## Unreleased` in
[CHANGELOG.md](CHANGELOG.md). To release, run one command on a clean `main`:

```bash
bun run release patch      # or: minor, major, or an explicit version such as 0.3.0-beta.1
```

It shows the version and release notes and asks for confirmation, then:

1. runs typecheck, tests and build (and stops if anything fails),
2. bumps `version` in `package.json` and moves the Unreleased notes under the
   new version,
3. commits `release: v<version>` and tags `v<version>`,
4. pushes both to GitHub.

The tag triggers the [Release workflow](.github/workflows/release.yml). It:
- checks that the tag matches `package.json`,
- runs the checks again,
- publishes to npm: prereleases go to the `next` dist-tag, everything else to
  `latest`,
- creates the GitHub release with that version's notes from the changelog.

Nothing besides git and Bun is needed locally. Pushing a tag by hand works
too, as long as `package.json` and `CHANGELOG.md` already contain the
version.

Flags:
- `--dry-run` shows the plan and changes nothing.
- `--no-push` only commits and tags locally.
- `--yes` skips the confirmation.

Which version to pick ([semver](https://semver.org)):

| Change | Before 1.0 | From 1.0 |
|---|---|---|
| Bug fix | `patch` (0.1.0 → 0.1.1) | `patch` |
| New feature | `minor` (0.1.0 → 0.2.0) | `minor` |
| Breaking change | `minor` (0.1.0 → 0.2.0) | `major` |

## One-time setup

npm lets you configure trusted publishing only for a package that already
exists, so the first version is published by hand.

1. Create an account on [npmjs.com](https://www.npmjs.com/signup) and enable
   two-factor authentication.
2. Publish the first version from your machine:

   ```bash
   bunx npm login
   bun publish                # runs typecheck, tests and build first
   ```

3. On npmjs.com, open **easytg → Settings → Trusted Publisher → GitHub
   Actions** and enter:
   - Organization or user: `viandwi24`
   - Repository: `easytg`
   - Workflow filename: `release.yml` (the file name only)
   - Environment: leave empty (the workflow uses none)

   Now GitHub Actions can publish without any token.
4. Recommended: on the same page, set **Publishing access** to *Require
   two-factor authentication and disallow tokens*. After that, only the
   workflow can publish.

Then run `bun run release 0.1.0`. It dates the changelog and pushes the
`v0.1.0` tag. The workflow sees that 0.1.0 is already on npm, skips
publishing and only creates the GitHub release. From then on, `bun run release patch|minor|major`
does everything.

### Alternative: publish with a token

To skip trusted publishing:
1. Create a *granular access token* with read and write access to `easytg` on
   npmjs.com.
2. Save it as the repository secret `NPM_TOKEN` (**Settings → Secrets and
   variables → Actions**).

The workflow uses the token automatically. With a token, even the first
version can be published from GitHub.

## Troubleshooting

**`npm error code ENEEDAUTH` in the Release workflow.** GitHub Actions has no
permission to publish: the Trusted Publisher on npmjs.com is missing or
doesn't match (user `viandwi24`, repository `easytg`, workflow
`release.yml`, no environment), and there is no `NPM_TOKEN` secret. Fix it,
then open the failed run in **Actions** and press **Re-run all jobs**. The tag
already exists, so no new release is needed.

**The tag doesn't match `package.json`.** Tags must be `v` + the exact version
(`v0.2.0` for `"version": "0.2.0"`). `bun run release` always gets this right.
