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
or generated archives. Follow the README's pinned-source procedure when updating bundled relays.

## Reporting a problem

[Open an issue](https://github.com/ahmed-hassan19/debate-skill/issues) with your install command and version,
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
   or reuse a published version. Update the README's release status only after registry verification.

Keep publication separate from ordinary test and pull-request workflows. A failed publication is not a release.
