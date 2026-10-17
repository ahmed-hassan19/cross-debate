# Two-reviewer PR and local review

Two reviewer sessions examine the change before anything is posted. A main reviewer finds issues. A debate reviewer tries to
knock them down and may add its own. The main reviewer then makes the final call, and one review with
inline comments lands on the GitHub PR. It posts from the user's own `gh` account as a non-approval
`COMMENT` review. It never approves and never requests changes.

You are the orchestrator. You run one command and relay the result. You do not review the diff
yourself, and you do not touch the PR. Standalone output has no orchestrator verdict; the plan and candidate
workflows separately require orchestrator verification. A single CLI is supported for both reviewer roles.

Automatic use comes through the opted-in code workflow ([code](code.md)). Explicit requests for PR or local
review work outside automatic scope; this command does not change repository config.

## Run it

`<cross-debate-dir>` is defined in the skill's SKILL.md.

```bash
node "<cross-debate-dir>/scripts/debate.mjs" review --local [--base <ref>]
node "<cross-debate-dir>/scripts/debate.mjs" review <pr-url | number> [--dry-run]
```

- If the user wants a review and there is no PR URL, run `--local` from the repo (or `--repo-dir`). Do not invent a
  URL. Relay stdout. `--local` never talks to a forge and rejects non-UTF-8 Git paths rather than decoding them lossily.
- `<pr-url>` is a GitHub `/pull/N` URL. A bare number resolves against the cwd's `origin`. GitHub Enterprise hosts
  work when `gh` is logged in to them; any other forge is rejected with an explicit error.
- `--dry-run` runs models and consumes provider usage, then prints the review without posting. It does not combine with `--local`.
- Reviewers run in a disposable checkout. Before they start, the diff is scanned for secrets and project agent
  configuration (`.claude/`, `.codex/`, `.opencode/`, `opencode.json[c]`, `.mcp.json`) is removed, so a reviewed PR's
  hooks, plugins or MCP servers never run. Tracked `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and
  `AGENTS.override.md` files are removed at every depth, so reviewer CLIs never auto-load the PR's own instructions.
  Claude and OpenCode reviewers also run with their own instruction loading off (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`,
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`); the Claude switch also skips the user's `~/.claude/CLAUDE.md`. Codex
  relies on the removal alone.
- Standards (`CONTRIBUTING.md`, `CODING_STANDARDS.md`, `CLAUDE.md`, `AGENTS.md`, the PR template,
  `.github/copilot-instructions.md`, `.cursorrules`, `docs/agents/`, `.cursor/rules/`, plus `CLAUDE.md` and
  `AGENTS.md` in each parent directory of a changed path) are read from the base commit, not the head, and
  handed to all three reviewer stages as `.txt` copies. A nested file applies only at or below its directory.
  At most 20 are listed (root files first, then the nearest nested ones); the brief says how many were cut.
  A PR that edits them is held to the base rules; its edits are reviewed as code.
- Efficiency findings are advisory and never block. Findings may carry a one-click GitHub `suggestion` when
  both reviewers stand behind the exact fix ([comment format](comment-format.md)).
- The reviewers are two delegate-skills lanes, `review-main` and `review-debate`. If either is missing the
  command says so; ask the user to run `debate.mjs setup init` in their own terminal
  (`setup lanes` proposes defaults non-interactively). Different reviewer choices can add model diversity;
  identical choices are supported but provide less diversity. For a one-off, pass
  `--main <implementer>` or `--debate <implementer>` (OpenCode needs a model, so use `--main-lane`/`--debate-lane`
  with a lane that binds one). Only implementers whose relay has `--read-only` are
  accepted. These two lanes belong to the reviewer; don't point them at a lane you use for other work.
- Exit code `3` means this head sha already has a debate review. Re-run with `--force` to post again.
- A run takes minutes, since it is two or three implementer sessions back to back. Claude runs it with
  `run_in_background: true`; other hosts run it in the foreground with a long timeout (there is no `--detach` or
  `wait` for this command). Report the printed URL when it finishes.

All flags: `review --help`. Contracts: [schema](schema.md). What gets posted: [comment format](comment-format.md).
The reviewer briefs live in `assets/prompts/` and the command fills them in; you don't need to read them.

## After it posts

Each posted comment carries a `<!-- debate-review:<id> status=... -->` marker. If the babysit-pr skill is
installed, it can handle the follow-up rounds (verify, fix blockers, reply, resolve). Otherwise relay the
findings to the user. Don't act on the findings yourself unless asked.

## Artifacts

`~/.cache/debate-review/<owner>__<repo>/<N>/<head>/` holds `run.json` (all three documents, timings,
what was posted) plus `main/`, `debate/`, and `final/`, each with the brief sent and the relay's
`result.json`. `--local` writes under `~/.cache/debate-review/local/<repo>/<branch>/<head>/` instead.
