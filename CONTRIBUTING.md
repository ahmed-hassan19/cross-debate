# Contributing

Use Node 22+ and Git on macOS or Linux. Start with:

```sh
npm ci --ignore-scripts
npm test
```

The runtime also supports Node 18. Keep its scripts free of npm dependencies. Installer dependencies belong
in `bin/`; hooks must keep working after the npm cache is removed. Tests use temporary homes and stub
reviewers. Never point installation tests at your real agent settings.

For packaging changes, run the archive installation check directly:

```sh
node --test tests/package.test.mjs
```

It packs the repository, extracts it outside the checkout, installs locked dependencies offline from the
cache populated by `npm ci`, and runs the wizard with scripted answers. It then removes the extracted npm
package and checks the installed runtime. This checks packaging and configuration, not model quality or
interactive host trust.

Keep each pull request focused. Describe the user-visible change and the checks you ran. Add a regression
case for behavior changes. Do not include local `AGENTS.md`, `CLAUDE.md`, review transcripts, credentials,
or generated archives. Follow the [pinned-source procedure](#updating-the-bundled-delegate-skills) when updating bundled relays.

## Reporting a problem

[Open an issue](https://github.com/ahmed-hassan19/cross-debate/issues) with your install command and version,
OS, `node --version`, host, reviewer CLIs, expected result, and the smallest reproduction. Include relevant
`setup doctor` output. Remove tokens, private repository URLs, personal paths, and source code you cannot share.
For a workflow problem, include the failed stage and error class; a full session transcript is rarely needed.

## Releasing

1. Use a clean, reviewed commit. Run `npm ci --ignore-scripts` and `npm test`; verify the CI matrix passes.
2. Choose the release version and update `package.json` and `package-lock.json` together with
   `npm version <version> --no-git-tag-version`. Review the resulting diff and record user-visible changes.
3. Run `node --test tests/package.test.mjs` on the release candidate. Inspect `npm pack --dry-run` for
   unexpected files and confirm the skill includes both its own license and upstream notices.
4. In a scratch project, install interactively, restart a supported host, accept hook trust if prompted, and
   exercise a plan review and local code review. Record host/CLI versions and any unperformed checks.
5. After committing the reviewed release candidate, run `npm whoami`, create the archive with `npm pack`, and
   publish it with `npm publish <archive.tgz> --access public`. npm authentication and any required 2FA belong
   to the maintainer.
6. Verify the registry version and run `npx cross-debate@<version> --help` from outside the checkout. Create a
   matching version tag and GitHub release with the changes and known limitations. Never move a published tag
   or reuse a published version. Switch the README and installer hints to the shorter npm registry command
   only after registry verification.

Keep publication separate from ordinary test and pull-request workflows. A failed publication is not a release.

## Regenerating the field report

`node scripts/history-report.mjs --help` describes the accepted metadata layouts. The reporter reads local
files without modifying them, calling models, or making network requests. It is intentionally excluded from
the npm package. Archives are opt-in; custom `--out-dir` locations outside the documented layouts are excluded.

Before publishing a snapshot, copy the selected metadata into a private directory outside the repository,
preserving each root's relative layout. Include the current debate home, the standalone cache, and every
explicitly selected archive (the initial snapshot includes the 2026-09-30-cleanup archive). Freeze these copies.
Keep an inventory there with the capture start/cutoff, ordered source roots, relative copied filenames,
byte sizes, and SHA-256 digests. Verify those digests before regeneration; never substitute mutable live inputs.
The inventory and copied files can contain private content and must not enter a commit or public artifact.

Replace the placeholder paths below with the frozen copies; repeat `--archive` in the recorded order:

```sh
node scripts/history-report.mjs --home /private/frozen/home --review-cache /private/frozen/review-cache \
  --archive /private/frozen/archive-1 --format json > /tmp/field-report.json
node scripts/history-report.mjs --home /private/frozen/home --review-cache /private/frozen/review-cache \
  --archive /private/frozen/archive-1 --format markdown > /tmp/field-report.md
```

Compare the JSON values with the published aggregate snapshot (whitespace may differ). Record the inventory
cutoff beside the generated report and link the aggregate JSON. Keep the cohort definitions, coverage, and
limitations intact. Review public output for private identifiers, paths, hashes, narratives, and quotations;
publish only the allowlisted aggregates. Run both `tests/history-report*.test.mjs` suites and the package check.
Readers can reproduce the computation with their own local records, but cannot independently audit the private
records behind the published snapshot. This is one maintainer's recorded history, not a comparative benchmark.

## Updating the bundled delegate-skills

The seven files under `skills/cross-debate/vendor/delegate-skills/` come from one pinned upstream commit.
To update them, replace `FULL_COMMIT_SHA` below with the commit you have reviewed:

```sh
DELEGATE_COMMIT="FULL_COMMIT_SHA"
DELEGATE_SOURCE=$(mktemp -d)
git clone https://github.com/amElnagdy/delegate-skills.git "$DELEGATE_SOURCE" &&
git -C "$DELEGATE_SOURCE" checkout "$DELEGATE_COMMIT" &&
for f in claude-delegate/scripts/relay.mjs codex-delegate/scripts/relay.mjs opencode-delegate/scripts/relay.mjs \
         delegate-setup/scripts/config.mjs delegate-setup/scripts/lane.mjs delegate-setup/scripts/implementers.mjs \
         delegate-setup/scripts/discover.mjs; do
  cp "$DELEGATE_SOURCE/skills/$f" "skills/cross-debate/vendor/delegate-skills/$f"
done
npm test
```

Update the pinned commit in [THIRD_PARTY_NOTICES.md](skills/cross-debate/THIRD_PARTY_NOTICES.md) and inspect the
relay diff before committing. Each relay must retain its `--read-only` behavior and advertise it in `--help`.
