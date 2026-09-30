# Debate operations

`<debate-dir>` is the installed skill directory, resolved as SKILL.md describes. Substitute it before executing commands; use the quoted, literal absolute entrypoint path for native permission matching.

## Scope

Automatic coverage is evaluated at invocation time for every seat. Only Git repositories explicitly enrolled with direct local `debate.enabled=true` receive automatic reviews. Existing repositories with no setting, newly initialized repositories, and separate clones default off; there is no repository list, enrollment scan, or registry. Non-repositories receive no automatic review reminders or receipt gates. Minimal session bookkeeping (cwd, transcript, prompt generation) remains available for explicit invocations, without automatic baselines or candidate ledgers outside scope.

Inspect or change scope using the existing allowlisted entrypoint:

```sh
node "<debate-dir>/scripts/debate.mjs" scope status --cwd "<repo>"
node "<debate-dir>/scripts/debate.mjs" scope disable --cwd "<repo>"
node "<debate-dir>/scripts/debate.mjs" scope enable --cwd "<repo>"
```

Status is read-only. Scope uses direct repository-local Git boolean `debate.enabled`, shared by linked worktrees; global/system/includes cannot enroll repositories. Missing or false means disabled; invalid or unreadable local-config reads mean disabled with a diagnostic. If Git cannot identify the repository, scope remains disabled with the existing null-identity behavior. Enrollment is shared by linked worktrees, but separate clones and nested repositories require their own enrollment. Use these commands rather than editing Git config: transitions supersede unconsumed push and delete approvals across linked worktrees. Disable refuses active candidates; finish or explicitly waive first. Missing/prunable/unreadable worktrees or ledgers require explicit repair before changing scope. Re-enabling never revives an old approval. Candidate ledgers remain worktree-specific.

Native `.git` write permissions still apply. Run `scope enable` from a plain shell when enrolling, then start fresh agent sessions; a mid-session activation requires the existing explicit baseline recovery instead of inventing a before-change baseline.

Literal `cd` and `git -C` targets determine mutation scope, not the starting shell directory. A guarded push must occupy the whole command, optionally after one literal `cd <dir> &&`; Git `-c`, `--config-env`, `--exec-path`, and `--namespace` overrides are unsupported for guarded mutations. The only other permitted push form is the lease-guarded branch delete returned by `approve-delete`, valid once under its approval. Unsupported push syntax remains denied even outside scope: wrappers, substitutions, pipelines, unresolved/non-worktree targets, Git directory overrides, and GIT_* environment overrides. An ordinary literal push in an unenrolled worktree bypasses the automatic permit gate. Explicit skill use still requires candidate/destination approval; do not claim permit enforcement or consumption when guards are off. `DEBATE=off`, the debate-home off file, and child-session suppression retain their existing semantics.

The `review` command is the backend invoked by `code review`. Automatic use comes through an enrolled workflow; explicit plan, code, or review requests remain supported without enrollment. No repository should be enrolled merely because a skill was invoked.

## Reviewer failure and recovery

A code finish with outcome `blocked` keeps the candidate active and can continue before round 3 with an amendment that changes the tree followed by `review --run <run>`; at round 3, `exhausted_with_blockers` requires an explicitly approved waiver to close.

One automatic retry is allowed per run across all rounds. A rate-limited failure spends that retry immediately, because the reviewer will not recover within the retry window: the run stops with the reset hint in its warnings and `--retry` is refused. Any further failure is a user-decision checkpoint, not a successful or warning-only finish. Report the failed stage, failure class, bounded/redacted diagnostics, and reset hint if supplied. Do not invent reset times or expose credentials. Read-only violations reject all output: investigate actual side effects and remediate before retrying or offering a replacement. Git state, secret scan, and lane-configuration preflight errors require repair, not a fallback model.

After retry exhaustion, stop work and ask the user. Use the seat's available question tool, or a concise ordinary question if unavailable. Check configured lanes, CLI presence, authentication/health using non-mutating checks where supported; installed is not proof of service availability. Say when availability is uncertain. Offer another verified reviewer, self-review by the orchestrator, pause, or the original reviewer after recovery. Do not silently delegate or infer a choice from a generic earlier “proceed.”

If the user already explicitly authorized a specific conditional fallback, honor that exact choice once and audit the actual instruction. This is prior user consent, not permission to invent further fallbacks or reset the automatic retry budget.

On an explicit choice to resume, quote the actual instruction and use the originating seat/session:

```sh
node "<debate-dir>/scripts/debate.mjs" plan resume --run "<run>" --seat "<seat>" --session "<session>" --reason "user authorized: <actual choice>" --detach
node "<debate-dir>/scripts/debate.mjs" code resume --run "<run>" --seat "<seat>" --session "<session>" --reason "user authorized: <actual choice>" --detach
```

Claude uses background execution instead of `--detach`/`wait`, except `wait --max-wait 1s` to reap a task that ended without output; every other host uses detach/wait. Omit lane flags to retain the previous reviewer. Only after the user explicitly selects a replacement, add plan `--reviewer-lane <configured-lane>` or code `--main-lane <configured-lane>` / `--debate-lane <configured-lane>`. Overrides are per-run, not global config edits; code lanes must have global bindings because review clones do not carry project trust. Every reviewer must use a relay that offers `--read-only`. Default pinned lanes remain unchanged without an authorized override.

The code Stop hook reports an active review attempt as a running review and blocks completion until its result is recorded. Do not launch a duplicate review or register a deferral merely because the background worker has not finished. If the worker has exited without recording a result, reap it with `wait --max-wait 1s` and follow the resulting failure/retry policy. After a review is recorded, the hook points to the required verdict or finish step.

Resume keeps all attempts and the same failed current-round snapshot; it grants exactly one attempt and leaves the automatic retry spent. A failed resumed attempt asks again. The three-round limit does not reset. A finished failure can resume only when its current round actually failed and exhausted retry, even if an earlier round succeeded. Old plan receipts are archived and invalidated, with a fresh receipt lifetime only after a new finish. Reopen the original thread for cross-session cases. Changed input needs an explicit recovery decision, never a covert retry-budget reset.

If the user chooses self-review, inspect the exact failed snapshot, write a separate report, and record it:

```sh
node "<debate-dir>/scripts/debate.mjs" plan finish --run "<run>" --self-review "<report>" --reason "user authorized: <actual choice>"
node "<debate-dir>/scripts/debate.mjs" code finish --run "<run>" --self-review "<report>" --reason "user authorized: <actual choice>"
```

Independent review remains failed; self-review cannot create a passed debate receipt. Code candidates stay active and require a separate explicit waiver before publication approval. Pausing requires no finish. Use code `defer` before asking if its Stop gate applies. Never fabricate the authorization quote.

Reports identify actual reviewer CLI/lane per attempt. Requested model and runtime-served model are distinct; unknown served models remain null, not inferred from lane aliases. Same-model coverage is labeled only when runtime metadata identifies both sides; a second process alone is not independent-model evidence.

## Dirty artifacts

Keep clean-worktree checks for review, finish, approval, and guarded publication. Inspect exact paths first. For expected generated files, and local-only files the user keeps uncommitted (e.g. `CLAUDE.md`, `AGENTS.md`), propose a narrow project `.gitignore` entry or local `.git/info/exclude`; for Python checks, `PYTHONDONTWRITEBYTECODE=1` can avoid bytecode. Do not globally ignore untracked files, stage junk, delete unknown files, or re-review an unchanged tree merely because a passed receipt coexists with artifacts. Report the receipt and dirty paths; remove only known task-created artifacts when authorized.

Dirty submodule worktrees are intentionally warning-only: receipts cover the parent repository tree and gitlinks, so edits inside a submodule do not invalidate a passed receipt or block Stop.

Untracked-file fingerprints use size and floored mtime as a cheap change detector; same-size edits with unchanged timestamps are outside this drift-guard threat model.

## Hooks and verification

Hooks are best-effort workflow guards, not a security boundary; the shell parser recognizes a limited set of command forms, not arbitrary scripts or aliases. Heredoc bodies (`<<`, `<<-`, including `$(cat <<'EOF' ... EOF)` commit messages) are prose, so apostrophes and the word `push` inside them are harmless; a bare-delimited body still has its `$(...)` and backquote substitutions analyzed, and a body fed to `bash`, `sh`, `zsh`, `dash`, or `ksh` is tokenized as commands, so a push inside either is still gated. Line continuations are joined and leading reserved words (`{`, `!`, `if`, `then`, `do`, …) skipped before the command word is read; a command word or Git subcommand produced by expansion (`$g push`, `git $p`) is denied because it cannot be classified. A heredoc still counts as a substitution for commit forms while a candidate is active.

The code Stop gate recognizes a promotion turn without a ledger write. A clean HEAD passes when it carries a passed/waived receipt by commit or by tree from the ledger of any worktree of the repository, or when every commit in `<session baseline>..HEAD` that is not on a remote-tracking ref is receipted (by commit or tree) or is a merge commit; published commits never appear in that list, so a pull, fast-forward, squash merge, or checkout of a published branch passes. Merge commits are trusted structurally: manual conflict edits inside one are not reviewed. A rebase that produced new trees still blocks, with a hint to register the promoted HEAD through `baseline --base "<HEAD>" --reason "promotion: ..."`; receipts match by commit or tree and ignore the base. Cost: nothing extra on the unchanged fast path; when HEAD moved, about seven Git calls plus one ledger read per worktree, and an unregistered promotion is re-walked on every Stop until `baseline` records it. Codex asks you to trust new or changed hook definitions; headless runs are not proof of interactive TUI behavior.

Codex plan-mode Stop passes when the final message has no `<proposed_plan>`; the hook cannot verify a plan that was not emitted in that form.

Read-only violations reject output; absent or null tripwire reports remain accepted with a warning, except Codex coverage is recorded as `sandbox` when no explicit tripwire result exists. The Codex relay ignores ambient user configuration (`--ignore-user-config`); code reviewers are launched by the `review` backend.

The offline suite exercises every host adapter, lifecycle gates, scope transitions, failure/resume state, and one-use publication approval without model calls. Real interactive validation needs the user: launch the agent, accept hook trust if requested, exercise a plan decision, deny then approve a manual escalation, and verify the hook events in the resulting transcript. Scripted auto-approval cannot verify human prompts. Record unperformed checks as pending, not passed.

## Hosts

| Host | Hook events | Plan gate | Code Stop gate | Git commit/push gate |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse (Bash, ExitPlanMode), Stop | ExitPlanMode | yes | yes |
| Codex | SessionStart, UserPromptSubmit, PreToolUse (Bash), Stop | final `proposed_plan` at Stop | yes | yes |
| Cursor (experimental) | beforeShellExecution | manual use only | no | yes |
| OpenCode (experimental) | `tool.execute.before` through a generated plugin | manual use only | no | yes |

`setup hooks --agent <host>` prints the exact entries; `setup doctor` reports which are installed. Every hook runs `debate.mjs hook <host> <event>`, exits 0 on internal errors (fail open), and passes unmapped events through. Claude reminds only in plan mode or while it owns an active candidate; Codex receives a plan or code instruction on every prompt. On Cursor and OpenCode, invoke the plan and code workflows yourself with `--seat cursor` or `--seat opencode` and an explicit `--session`.
