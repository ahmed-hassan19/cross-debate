# cross-debate

Cross-agent review for plans, code, and pull requests.

Your coding agent coordinates two reviewers, checks their findings, and keeps you in control of the push.

**Cross Debate workflows require a Git repository.** Non-Git directories do not receive automatic reviews.

- Plans get two reviews before your agent presents them.
- Finished code gets reviewed as a local candidate commit. Pushing requires your approval of that exact commit
  and destination.
- Pull requests get one consolidated GitHub review. Working-tree reviews print their findings locally.

## Install and use

You need macOS or Linux, **Node 22+**, a Git repository, and at least one signed-in reviewer CLI on `PATH`: `claude`, `codex`,
or `opencode`. Automatic reviews run in every Git project by default and consume reviewer-provider usage. Choose different CLI or model families for the two reviewers when available; using one CLI is supported.
GitHub PR reviews and merged-branch deletion also require authenticated `gh`.

### 1. Install globally

Run this from any directory:

```sh
npx --yes github:ahmed-hassan19/cross-debate
```

In the installer:

1. Select the agents you use, such as Claude Code or Codex.
2. Accept the recommended reviewers, or choose two reviewers and their models.
3. Review the summary and confirm **Apply these changes**.

**CLI default** is the first model choice. The installer shows at most one catalog suggestion per model family,
your existing choice when present, and **Enter another model**. It asks for OpenCode's `provider/model` ID.
Claude suggestions come from the [Models API](https://platform.claude.com/docs/en/api/models/list) only when `ANTHROPIC_API_KEY` is already set; otherwise it offers
Claude Code aliases. Codex suggestions come from its [local app-server model catalog](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). Discovery makes no inference
request and does not verify that your account can use a listed model. The installer does not read private CLI credentials.

Restart your agent. In Codex, accept the hook-trust prompt after reviewing it.

### 2. Use it

In Git projects, cross-debate runs automatically in Claude Code and Codex:

1. Enter plan mode and describe your task. The agent loads the skill and cross-reviews the plan before presenting it.
2. Approve the plan and proceed with implementation. The agent reviews the code, fixes confirmed blockers,
   and asks for approval before pushing.

<details>
<summary>Manual reviews: Cursor, OpenCode, opted-out projects, and pull requests</summary>

In Cursor or OpenCode, or in a project with automatic reviews disabled, ask the agent to use cross-debate:

```text
Use cross-debate to review this plan.
```

For code, replace "this plan" with "these changes".

To review a GitHub PR without posting yet:

```sh
npx --yes github:ahmed-hassan19/cross-debate review https://github.com/OWNER/REPO/pull/123 --dry-run
```

Omit `--dry-run` to post one GitHub `COMMENT` review, without approving the PR or requesting changes.
To review the current working tree locally:

```sh
npx --yes github:ahmed-hassan19/cross-debate review --local
```

</details>

<details>
<summary>Update, check setup, or stop automatic reviews</summary>

| What you want | Command |
|---|---|
| Update the skill or choose different reviewers | `npx --yes github:ahmed-hassan19/cross-debate` |
| Reverse a project opt-out | `npx --yes github:ahmed-hassan19/cross-debate scope enable --cwd "/path/to/project"` |
| Check dependencies and configuration | `npx --yes github:ahmed-hassan19/cross-debate setup doctor` |
| Show the CLI and installed skill versions | `npx --yes github:ahmed-hassan19/cross-debate --version` |
| Check the current project's automatic review status | `npx --yes github:ahmed-hassan19/cross-debate scope status` |
| Opt out the current repository and linked worktrees | `npx --yes github:ahmed-hassan19/cross-debate scope disable` |

`setup doctor` checks configuration and executable availability, not reviewer sign-in or native hook trust.
Warnings about hosts you do not use can be ignored. If `scope disable` reports an active candidate, finish
the review or explicitly waive it before disabling automatic reviews.

To remove cross-debate completely, follow [the removal steps](skills/cross-debate/references/operations.md#removal).

</details>

<details>
<summary>Installation troubleshooting, backups, and migration</summary>

- Project overrides in `.delegate/config.json` require explicit trust for plan review. Code-review lanes must
  use global bindings. Remove an unintended project override and rerun the check. The installer preserves
  project settings and never grants trust automatically.
- Malformed or symlinked settings files stop installation before Apply. Fix the file or resolve the symlink
  before rerunning. For an existing `writable_roots` array inside an inline Codex table, convert it to a
  `[sandbox_workspace_write]` table first. The installer preserves existing writable roots.
- Replaced entries are backed up under `~/.local/share/debate/install-backups/` (or
  `$DEBATE_HOME/install-backups/`), with a manifest of original paths.
- Upgrading from `debate` preserves review state, reviewer choices, `debate.enabled`, and old script paths.
  Updating activates automatic reviews in existing Git projects unless they already have an explicit opt-out.
  The installer migrates selected hosts without modifying the checkout behind a skill symlink. If an
  unselected host still uses a shared legacy registration, select that host on a later run to finish migration.

</details>

## How reviews work

1. Reviewer 1 and Reviewer 2 examine plans independently. For code, Reviewer 1 finds possible issues;
   Reviewer 2 challenges those findings and can add missed issues. Reviewer 1 then makes a final call.
2. Your agent verifies the claims and addresses confirmed issues. Plan and code workflows allow up to three
   rounds of review.
3. Before a push, you approve the exact commit and destination.

Agreement between reviewers is not proof; your agent remains responsible for checking the evidence. In Git
projects, host-specific hooks remind the agent to review and check receipts and push approvals. These are
best-effort workflow guards. Coverage depends on the host below.

## Host support

| Host | Plan review gate | Code completion gate | Git commit/push gate |
|---|---|---|---|
| Claude Code | Plan-mode exit | Yes | Yes |
| Codex | Final `proposed_plan` block | Yes | Yes |
| Cursor (experimental) | Manual request | No | Yes |
| OpenCode (experimental) | Manual request | No | Yes |

Codex's plan gate applies only when the agent emits a final `proposed_plan` block. For hook events, reminders,
and limitations, see [host operations](skills/cross-debate/references/operations.md#hooks-and-verification).

## Optional configuration

Rerun the installer to change reviewers or models. It stores reviewer settings in
`~/.config/delegate-skills/config.json` (under `XDG_CONFIG_HOME` when set).

A **lane** is a named reviewer role. Each lane selects an **implementer** (the reviewer CLI), with optional
`model` and `effort` or `variant` settings. Your **seat** is the host agent you are working in.

| Lane | Role |
|---|---|
| `plan-main` | First plan reviewer |
| `plan-debate` | Second plan reviewer |
| `review-main` | Main code and PR reviewer |
| `review-debate` | Reviewer that challenges code and PR findings |

`plan-main-<seat>` overrides the first plan reviewer for one host. For example, `plan-main-claude` can select
Codex to review plans written in Claude Code.

| Setting or path | Purpose |
|---|---|
| `DEBATE_HOME` | Plan/code run state and receipts; defaults to `~/.local/share/debate` |
| `DEBATE=off` | Disable hooks for the current session |
| `DELEGATE_SKILLS_DIR` | Use a specific delegate-skills checkout instead of the bundled copy |
| `~/.cache/debate-review/` | Standalone PR and working-tree review artifacts |

To inspect review statistics:

```sh
npx --yes github:ahmed-hassan19/cross-debate stats --since 30d
```

Claude Code's permission allowlist uses one entry for all commands: `Bash(node "<path>/debate.mjs":*)`.
`setup hooks --agent claude` prints the entries for the catalog path and its resolved path.

<details>
<summary>Manual setup commands and installation from a clone</summary>

The skill runtime also supports Node 18+. To install it manually, clone the repository and link the skill
into your agent's skill directory. This example uses Claude Code:

```sh
mkdir -p ~/src ~/.claude/skills
git clone https://github.com/ahmed-hassan19/cross-debate.git ~/src/cross-debate
ln -s ~/src/cross-debate/skills/cross-debate ~/.claude/skills/cross-debate
D="$HOME/.claude/skills/cross-debate/scripts/debate.mjs"
node "$D" setup init
```

In `setup init`, install hooks only for hosts where you have linked the skill. For Codex, replace every
`.claude/skills` path above with `.agents/skills`. The wizard prints the changes to merge into
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Replace the home-path placeholder below and preserve
existing tables and writable roots:

```toml
[features]
hooks = true

[sandbox_workspace_write]
writable_roots = ["/absolute/path/to/your-home/.local/share/debate"]
```

Restart your agent, trust the hooks when prompted, and follow [Install and use](#install-and-use).
To preview individual settings, use `node "$D" setup lanes` or `node "$D" setup hooks --agent claude`.
Add `--write` to apply a preview in your own terminal. For OpenCode lanes, add
`--opencode-model provider/model` to `setup lanes`.

The bundled delegate-skills relays and lane validator are pinned to one upstream commit. Other installed
copies do not affect cross-debate unless you set `DELEGATE_SKILLS_DIR`.

</details>

## Optional integrations

The manual `setup init` wizard detects these skills and offers their install commands. They are optional;
the default installer does not add them.

- [ponytail](https://github.com/DietrichGebert/ponytail): if installed, the code workflow runs one
  check for unnecessary complexity before project checks on substantial changes.
- babysit-pr from [review-skills](https://github.com/amElnagdy/review-skills): if installed, it can take over the
  follow-up rounds on posted PR review comments.

## Roadmap

- Plan and code completion gates for Cursor and OpenCode.
- Additional host adapters and PR review providers.

## Safety model

Hooks guide the workflow; they are not a security boundary. They can be disabled, and internal hook errors
fail open. The shell parser accepts a limited set of Git command forms and rejects unsupported push syntax.

Reviewers run through read-only relays. Code and PR reviews use a disposable checkout with project hooks,
plugins, and MCP configuration removed, and scan the outgoing diff for secrets before review. Plan reviewers
read from the original working directory. See [operations](skills/cross-debate/references/operations.md)
for the limitations and recovery procedures.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Tests use temporary homes and stub reviewers, with no model calls. The package test installs locked
dependencies offline from the cache populated by `npm ci`. CI covers the dependency-free runtime on Node 18
and 22, plus the installer on Node 22, on Ubuntu and macOS. Installed hooks need no npm dependencies.

See [CONTRIBUTING.md](CONTRIBUTING.md) for bug reports, package verification, and release steps.

<details>
<summary>Updating the bundled delegate-skills</summary>

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

</details>

## Special thanks

Thanks to the projects and authors this skill builds on:

- **Ahmed Nagdy** ([@amElnagdy](https://github.com/amElnagdy)) for
  [delegate-skills](https://github.com/amElnagdy/delegate-skills) (the relays and lane configuration bundled here) and
  [review-skills](https://github.com/amElnagdy/review-skills) (the debate-review backend this skill adapts, and
  babysit-pr).
- **Matt Pocock** ([@mattpocock](https://github.com/mattpocock)) for
  [grill-me](https://github.com/mattpocock/skills), which inspired the plan review's decision interview.
- **Dietrich Gebert** ([@DietrichGebert](https://github.com/DietrichGebert)) for
  [ponytail](https://github.com/DietrichGebert/ponytail), the optional check for unnecessary complexity.
- **Vercel Labs** for the [skills CLI](https://github.com/vercel-labs/skills), which informed the installer flow.
- **Bombshell** for [Clack](https://github.com/bombshell-dev/clack), the installer prompts.

Bundled and adapted code, with pinned upstream commits and license texts, is listed in
[THIRD_PARTY_NOTICES.md](skills/cross-debate/THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](skills/cross-debate/THIRD_PARTY_NOTICES.md).
