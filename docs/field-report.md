# Recorded review outcomes

Inventory cutoff: **2026-10-03 00:51:50 UTC**. The private frozen inventory contains 257 metadata files; it includes the explicitly selected 2026-09-30-cleanup archive. The files and their SHA-256 inventory remain outside this repository.

[Aggregate JSON snapshot](field-report.json) · [Regeneration procedure](https://github.com/ahmed-hassan19/cross-debate/blob/main/CONTRIBUTING.md#regenerating-the-field-report)

Dataset start range (UTC): 2026-09-10T20:03:38.098Z to 2026-10-03T00:48:59.535Z; 255 recorded starts.

One maintainer's changing workflows. These are recorded outcomes, not a benchmark against another method.

## Source coverage

| Selected source | Records |
| --- | --- |
| currentRaw | 229 |
| archiveRaw | 7 |
| currentStatsOnly | 0 |
| archiveStatsOnly | 0 |
| standalone | 19 |

257 metadata files read; 236 valid raw records, 421 valid stats rows, 19 valid standalone records before reconciliation.

0 duplicate raw records; 192 duplicate stats rows; 229 stats records replaced by raw records; 531 audit rows excluded.

0 malformed and 0 unsupported records; 0 symlinks skipped.

Stats-only coverage: 0 runs (none). These lack raw finding joins and are excluded from the workflow tables.

## Workflow occurrences

| Metric | Plan | Code |
| --- | --- | --- |
| Raw workflow runs | 92 | 144 |
| Runs with verdicts | 81 | 135 |
| Rounds / runs with rounds | 159 / 92 | 163 / 139 |
| Attempts / failures | 181 / 33 | 179 / 20 |
| Runs with attempts | 92 | 139 |
| Runs with failed attempts | 18 | 14 |
| Finding occurrences / adjudicated | 508 / 490 | 112 / 112 |
| Confirm / modify / discard | 365 / 96 / 29 | 92 / 2 / 18 |
| Runs with findings / adjudicated findings | 83 / 81 | 53 / 53 |
| Runs with confirm / modify / discard | 78 / 50 / 18 | 42 / 2 / 11 |
| Runs with accepted findings | 80 | 43 |
| Accepted blocking occurrences / runs | 48 / 32 | 40 / 14 |
| Recorded fixed occurrences / runs | 0 / 0 | 55 / 18 |
| Recorded blocking fixes / runs | 0 / 0 | 31 / 11 |
| Backend-agreed occurrences discarded / runs | 0 / 0 | 17 / 10 |
| Unadjudicated findings / unmatched verdicts | 18 / 0 | 0 / 0 |
| Runs with unadjudicated findings / unmatched verdicts | 2 / 0 | 0 / 0 |

plan: recorded statuses: running: 1; awaiting_verdict: 2; stopped: 3; review_failed: 1; finished: 85. Recorded outcomes: completed: 79; failed: 6; missing: 7.

plan: review states: failed: 11; unfinished: 3; changedAfterReview: 68; finishedWithVerdict: 10. Attempt states: running: 1; completed: 147; failed: 33.

code: recorded statuses: running: 1; finished: 143. Recorded outcomes: passed: 125; failed: 1; waived: 16; changed_after_review: 1; missing: 1.

code: review states: failed: 1; waived: 16; unfinished: 1; changedAfterReview: 6; finishedWithVerdict: 120. Attempt states: running: 1; completed: 158; failed: 20.

Each occurrence is identified by (runId, round, findingId) internally. Verdicts join only to findings in the same round. Confirm/modify counts as accepted; blocking uses that finding's recorded severity. Fixes require an accepted verdict with fixed=true. Plan change prose is not a recorded fix. Occurrences can repeat a bug across rounds; these are not unique bugs or semantic deduplication.

A finished/completed label alone does not establish successful review. Failed, waived, unfinished, blocked, and changed-after-review records remain separate. Finished-with-verdict is a coverage category, not a quality judgment.

## Time and usage coverage

| Measurement | Recorded / eligible | Missing | Total | Median |
| --- | --- | --- | --- | --- |
| plan: recorded attempt seconds | 178 / 181 | 3 | 73635 | 313.5 |
| plan: wall elapsed seconds | 85 / 92 | 7 | 234328.986 | 909.408 |
| code: recorded attempt seconds | 177 / 179 | 2 | 57727 | 232 |
| code: wall elapsed seconds | 143 / 144 | 1 | 191441.413 | 302.911 |
| standalone: recorded stage seconds | 42 / 42 | 0 | 5901 | 77 |
| standalone: wall elapsed seconds | 16 / 19 | 3 | 5663.612 | 186.946 |

Attempt time is the recorded attempt.seconds field; its measurement differs across workflow versions. Wall elapsed time is finishedAt minus createdAt/startedAt and can include waiting and interruptions. These are not interchangeable. Missing or invalid values are excluded, not zero-filled.

| Measurement | Recorded / eligible | Missing | Total | Median |
| --- | --- | --- | --- | --- |
| plan: provider-reported inputTokens | 244 / 325 | 81 | 89139765 | 246114 |
| plan: provider-reported outputTokens | 244 / 325 | 81 | 2347702 | 3248.5 |
| plan: provider-reported cacheReadTokens | 244 / 325 | 81 | 75282218 | 201344 |
| plan: provider-reported cacheWriteTokens | 244 / 325 | 81 | 8497161 | 0 |
| plan: provider-reported costUsd | 200 / 325 | 125 | 267.3579 | 0.7037 |
| code: provider-reported inputTokens | 310 / 416 | 106 | 91798010 | 160852 |
| code: provider-reported outputTokens | 310 / 416 | 106 | 920762 | 1699.5 |
| code: provider-reported cacheReadTokens | 310 / 416 | 106 | 78485896 | 128256 |
| code: provider-reported cacheWriteTokens | 310 / 416 | 106 | 3209588 | 0 |
| code: provider-reported costUsd | 172 / 416 | 244 | 91.6347 | 0 |

Usage denominators are recorded agent entries, not every possible provider call. Cost is provider-reported USD coverage, not total spend or ROI. Cache fields are already represented in provider input accounting where applicable; do not add them to input totals. No model rankings, causal comparisons, or time-saved claims are made.

| Measurement | Recorded / eligible | Missing | Total | Median |
| --- | --- | --- | --- | --- |
| plan: orchestrator inputTokens (non-additive) | 85 / 92 | 7 | 273487380 | 2069502 |
| plan: orchestrator outputTokens (non-additive) | 85 / 92 | 7 | 1218073 | 11304 |
| code: orchestrator inputTokens (non-additive) | 129 / 144 | 15 | 491855681 | 1881895 |
| code: orchestrator outputTokens (non-additive) | 129 / 144 | 15 | 1344261 | 4707 |

Orchestrator tokens cover transcript windows and may overlap other work. They remain separate and must not be added to reviewer totals.

## Standalone cache coverage

19 records: 8 local and 11 PR reviews. 14 contain both main and debate stages; 14 contain a rendered review; 16 have a finished timestamp. A timestamp is also written on failure and does not prove success or posting.

26 source finding occurrences. Final backend dispositions: agreed: 18; contested: 2. Orchestrator verdicts: 0. These records do not establish accepted fixes. Provider usage is not recorded in this metadata schema.

## Cohorts and limitations

Workflow input is `runs/*/run.json` plus `stats.jsonl`. Explicit archives also allow `stats.jsonl.bak`. Raw wins over stats, current sources win over archives within each class, later archive arguments win archive ties, stats.jsonl wins over its backup, and the last row within a file wins. Audit events, sessions, receipts, and nested code backend files are not additional runs.

Standalone input is limited to `<owner>__<repo>/<pr>/<sha12>/run.json` and `local/<repo>/<branch>/<sha12>/run.json`. clones/, arbitrary deeper files, symlinks, and custom --out-dir locations outside these layouts are excluded. Cached paths can overwrite earlier executions; absence of metadata does not prove no review occurred.

Only explicitly supplied archives are included. Private source records, prompts, narratives, identities, and paths are excluded from public output. Computation is reproducible locally from frozen metadata; readers cannot independently audit the private source records. Record the inventory cutoff beside a published snapshot.

[Regeneration and private snapshot procedure](https://github.com/ahmed-hassan19/cross-debate/blob/main/CONTRIBUTING.md#regenerating-the-field-report).
