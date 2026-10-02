# Code candidate review and push gate

Only you communicate with the user. Verify every source finding, including withdrawn findings.
Never push without explicit candidate-and-destination approval; never amend published history.
Keep the candidate local throughout review; do not bypass project checks or use --no-verify.
Commands use your seat (`claude`, `codex`, `cursor` or `opencode`) and the hook-provided session ID.
`<cross-debate-dir>` and the scope rules are defined in the skill's SKILL.md. Outside automatic scope, invoke only on
explicit request; approval requirements still apply even though automatic review and permit guards are inactive.
The `review` subcommand ([review](review.md)) is the backend; explicit review requests do not require enrollment.
For scope, dirty artifacts, recovery, or hook verification, read [operations](operations.md).

**Execution rule.** Claude runs `code review` as a Bash call with `run_in_background: true` and, when it
completes, reads the result with `code wait --run "<run>" --max-wait 1s`. Every other host adds `--detach` and polls with `code wait --run "<run>" --max-wait 60s`.

1. Complete implementation and run the project's relevant checks before reporting completion.
   If the ponytail-review skill is installed: before those checks, for substantial new code, abstractions,
   dependencies, or duplicated logic, run it once; skip straightforward changes. Findings are advisory; line
   reduction is not an acceptance criterion. Before applying a suggestion, compare public signatures, accepted
   inputs, outputs, exceptions, ordering, and side effects with the existing behavior; apply only
   behavior-preserving cleanup. Any additional behavior change outside the agreed requirements is a spec decision:
   leave it unapplied or ask. Do not rerun it automatically after review rounds; reconsider only if substantial new
   implementation is introduced, and treat resulting cuts as amendments that need re-review.
   Inspect inherited changes before staging; do not silently absorb unrelated work.
   For an unfinished checkpoint or necessary question:
   node "<cross-debate-dir>/scripts/debate.mjs" code defer --seat "<seat>" --session "<session>" --cwd "<cwd>" --reason "<why unfinished>"
   A deferral cannot accompany a completion claim and never permits a push.
   This is honor-based: the hook consumes a deferral on the next Stop without interpreting completion intent.
   Do not use `defer` merely because a review worker is running in the background. A deferral does not wait
   for or reap that worker; keep the review task active and consume its completion instead.

2. If you made several unpublished commits this session, squash them to one commit before begin:
   git reset --soft "<before-change-sha>"   then   git commit -m "<type>: <description>"
   Then use begin --adopt below; adoption accepts only one commit with the base as its sole parent.
   Otherwise start a fresh candidate before committing:
   node "<cross-debate-dir>/scripts/debate.mjs" code begin --seat "<seat>" --session "<session>" --cwd "<cwd>"
   Default base is current HEAD, not the session's original baseline. Retain the returned runId.
   In the repository cwd, run these as separate shell tool calls:
   git add -A
   git commit -m "<type>: <description>"
   If the candidate was already committed without begin, adopt only that unpublished HEAD:
   node "<cross-debate-dir>/scripts/debate.mjs" code begin --seat "<seat>" --session "<session>" --cwd "<cwd>" --adopt --base "<sole-parent-sha>" --reason "<evidence it is unpublished>"
   Use your observed commit-without-push history or explicit user confirmation as evidence.
   If publication status is unknown, ask the user before adoption; do not infer it from stale remote refs.
   A parent mismatch must be resolved explicitly; do not rewrite earlier commits to make adoption pass.

3. If Stop reports no session baseline, explicitly register the known before-change commit:
   node "<cross-debate-dir>/scripts/debate.mjs" code baseline --seat "<seat>" --session "<session>" --cwd "<cwd>" --base "<before-change-sha>" --reason "<basis for this baseline>"
   HEAD is acceptable only when nothing changed; registration is audited.
   For an already-created candidate, use its intended sole parent and then the adoption command.
   On a promotion turn (merge, pull, or checkout of reviewed work) Stop passes on its own when HEAD moved only by
   published commits, commits receipted in any worktree of the repository, or merge commits. Otherwise register
   the promoted HEAD: baseline --base "<HEAD>" --reason "promotion: <what was merged and where it was reviewed>".
   Never create a no-op candidate to re-review promoted work.

4. Review the candidate.
   Claude: invoke this Bash command with run_in_background: true:
   node "<cross-debate-dir>/scripts/debate.mjs" code review --run "<run>" --timeout 30m
   When the background task completes, take the result from wait --run "<run>" --max-wait 1s: it prints the recorded
   review document as clean JSON (the task output file ends with a host exit-status line, so it is not valid JSON),
   and it also reaps a worker that died without recording a result.
   If Stop fires while that command is running, do not start another candidate, launch a duplicate review, or
   register a deferral as a substitute for waiting. The Stop gate will identify the active review; wait for its
   completion, then record the verdict and finish. If the worker is dead, use the one-second wait command and
   follow the recorded recovery state.
   Other hosts (Codex: request review-prefix escalation first) run:
   node "<cross-debate-dir>/scripts/debate.mjs" code review --run "<run>" --timeout 30m --detach
   Then observe (inside workspace-write on Codex):
   node "<cross-debate-dir>/scripts/debate.mjs" code wait --run "<run>" --max-wait 60s
   On Codex, recommend approve-for-prefix for git separately: .git writes are not covered by the review approval.
   Without reused approvals, budget 1 review + 2 initial Git approvals + up to 3 amend approvals.
   Re-staging fixes can add further Git approvals; a reusable git prefix covers those Git operations.

5. secrets_detected means no reviewer ran. Inspect redacted locations locally, correct the candidate, and amend.
   Re-run project checks and use separate staging/amend tool calls, then invoke review again.
   Removed and context lines are scanned too: removing a secret already in the base still trips the scan and needs an explicitly approved waiver.
   An unresolvable scan hit or unsupported state must be reported; do not bypass the scanner to send the diff.
   For reviewer failure, use code review --run "<run>" --retry once, with the same execution rule.
   After that retry fails, STOP and ask the user. This includes rate limits, unavailable agents, timeouts,
   service/internal errors, invalid output, and read-only violations (investigate those before any retry).
   Read the recovery procedure in [operations](operations.md). Offer only verified
   alternatives: another available reviewer, self-review, pause, or retry the original after recovery.
   Never silently switch agents, finish, waive, or create a fresh run to reset the retry budget.
   Each explicitly authorized resume grants one attempt, not another automatic retry; the three-round cap stays.
   Do not retry deterministic preflight errors as model failures.

6. Validate every main/debate finding against the candidate, regardless of final agreed/contested/withdrawn status.
   Fix confirmed blockers; rerun project checks; use separate shell calls:
   git add -A
   git commit --amend --no-edit
   Every correction in this loop amends the same candidate and preserves its parent.
   Ask only material unresolved decisions; batch them with numbered recommended answers.
   Use defer before a question checkpoint; use ordinary user-facing text if the seat's question tool is unavailable.

7. Write verdict JSON under the run directory:
   {
     "review_rating":8,
     "no_further_review":false,
     "verdicts":[{"id":"R1:F1","verdict":"confirm","reason":"...","evidence":"path:line","change":"...","fixed":true}],
     "contest_rulings":[],
     "assumptions":[],
     "missed":[{"claim":"...","evidence":"path:line","change":"..."}],
     "checks":[{"command":"<project check>","result":"passed"}]
   }
   Use wrapper-returned IDs; validate withdrawn findings instead of automatically discarding them.
   node "<cross-debate-dir>/scripts/debate.mjs" code verdict --run "<run>" --round <n> --verdicts "<verdict-file>"
   A declared fix requires an actual candidate tree change; finish refuses next=continue.
   Continue iff a correction requires re-review and round < 3; repeat step 4 with the same run.
   Set no_further_review true only when every amendment answers a non-blocking finding; the round then stops as
   agreed if no blocking finding is live or unfixed and no missed entry carries a fix. Finish passes the amended
   commit with unreviewedAmendment true, disclosed in the report, the receipt, and the push request.
   At round three, amended content is changed_after_review; do not claim it passed.

8. Finish:
   node "<cross-debate-dir>/scripts/debate.mjs" code finish --run "<run>"
   Report candidate SHA, review outcome, relevant checks, and unresolved findings; the commit remains local.
   Unfixed blockers record blocked and keep the candidate active: while round < 3, amend the fix and code review --run "<run>" again on a changed tree.
   At round 3, exhausted_with_blockers stays frozen; only an explicitly approved waive can close it.
   Every waiver, including a prose typo/comment-only candidate, requires explicit user approval:
   code waive --run "<run>" --reason "user approved: <actual instruction>".
   If HEAD is still the original base and the worktree is clean, this abandons the run without a review receipt
   or publication approval. It also frees the worktree for another candidate or scope disable.
   Security, auth, config, migration, and dependency changes are not trivial by size.
   Failure, blockers, secrets_detected, or unreviewed corrections require explicit user approval before waiver.

9. Only after presenting the concrete result, ask whether to push this candidate to the named destination.
   After explicit approval, and waiver first if required:
   node "<cross-debate-dir>/scripts/debate.mjs" code approve-push --run "<run>" --remote "<remote>" --ref "refs/heads/<branch>" --reason "user approved: <quote>"
   Execute only the exact push command returned; it starts with cd '<worktree>' && so it works from any tool
   working directory. Do not add refs, force, tags, or another destination.
   Approval is consumed for that attempt. Failure requires a new explicit retry approval.
   Never infer publication success from a timeout. Never amend a candidate after publication approval.

   Deleting a merged PR's branch needs no run, only explicit user approval, one branch per approval:
   node "<cross-debate-dir>/scripts/debate.mjs" code approve-delete --cwd "<worktree>" --remote "<remote>" --ref "refs/heads/<branch>" --pr "<PR URL>" --reason "user approved: <quote>"
   The PR must be the one merged into the intended upstream. It verifies with gh that the PR is merged from that
   branch of the remote's push repository and that the branch hasn't moved since, and refuses the default branch.
   Execute only the returned command; its --force-with-lease makes Git refuse the delete if the branch moved.
