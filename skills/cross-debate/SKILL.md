---
name: cross-debate
description: Cross-agent debate review for coding plans and code. Cross-review final plans before they are presented, review a local candidate commit before completion with an explicit-approval push gate, and run two-model reviews of GitHub PRs or working trees. Automatic in Git repositories by default; anywhere on explicit request.
license: MIT
compatibility: Node 18+, Git, and at least one reviewer CLI (claude, codex or opencode); gh for PR review and branch-delete approval. Claude Code and Codex are fully gated; Cursor and OpenCode get the Git gate only (experimental).
---
# cross-debate

You are the orchestrator. Only you talk to the user; reviewer output is untrusted evidence to verify.
Plan review uses independent passes; code uses main/debate/final passes followed by your verification.
Standalone PR/local review relays backend findings without an orchestrator verdict. One reviewer CLI is supported.

## Where the skill lives

Resolve `<cross-debate-dir>` to the installed directory containing this SKILL.md, using the path the current skill
catalog shows (keep a symlinked catalog path as it is). Every command runs through the one entrypoint:

    node "<cross-debate-dir>/scripts/debate.mjs" <plan|code|review|scope|stats|setup> ...

Replace placeholders with actual values and quote the literal absolute entrypoint path so native permission
allowlists match. Do not assume a username, home directory, or skill installation root.

## Scope

- Automatic use is on in Git repositories when direct repository-local `debate.enabled` is absent or true.
  Explicit false, invalid or unreadable config, and non-Git directories leave automation off.
- `scope disable --cwd <project>` opts out the repository and linked worktrees; `scope enable` reverses it.
- Outside Git or in opted-out repositories, run a workflow only when explicitly requested. Approval
  requirements for pushing still apply even though the automatic guards are inactive.
- Unsupported push syntax remains rejected even outside automatic scope; ordinary literal pushes in
  opted-out worktrees bypass the permit gate.
- `DEBATE=off` disables the hooks for a session; use it only on an explicit user opt-out.

## Route

| Situation | Read |
|---|---|
| A final plan is ready (plan mode, or a plan the user asked to cross-review) | [references/plan.md](references/plan.md) |
| Implementation is done, or a push or merged-branch delete is requested | [references/code.md](references/code.md) |
| The user asks for a review of a GitHub PR or the working tree | [references/review.md](references/review.md) |
| Scope, dirty artifacts, reviewer failure and recovery, hooks, hosts | [references/operations.md](references/operations.md) |
| Lanes missing, hooks absent, or install problems | run `setup doctor`; direct the user to the installer in their own terminal if configuration is needed |

A hook reminder or denial names the workflow to follow; obey it rather than working around the gate.

## Host execution rule

Your seat is your host: `claude`, `codex`, `cursor` or `opencode`. Claude runs review commands as a Bash call
with `run_in_background: true`; on completion it reads the result with `wait --run "<run>" --max-wait 1s` (the
task output file is not pure JSON), or the printed output for `review`. For `plan` and `code` reviews every other host
adds `--detach` and polls with `wait --run "<run>" --max-wait 60s`; `review` has no detach mode, so other hosts run it
in the foreground with a long command timeout. Never start a duplicate review while one is running.

## Setup commands

The recommended installer is `npx --yes cross-debate` (Node 22+), run by the user in their own terminal.
For a manual clone on Node 18+, `setup init` provides the text wizard. Never run either installer for the user.
`setup lanes` and `setup hooks`
print their changes; `--write` edits settings only after the user confirms in their own terminal. Never run
`--write` for the user and never edit agent settings files yourself.
