<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/mark-dark.svg">
  <img src="docs/assets/mark-light.svg" alt="" width="64" height="64">
</picture>

# Cross Debate

[![CI](https://github.com/ahmed-hassan19/cross-debate/actions/workflows/test.yml/badge.svg)](https://github.com/ahmed-hassan19/cross-debate/actions/workflows/test.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-52615d)](LICENSE)
[![Node 22+ installer](https://img.shields.io/badge/installer-Node_22%2B-327b73)](docs/setup.md)

Cross-agent review for plans, code, and pull requests.
Your coding agent coordinates two reviewers, verifies findings in plan and code workflows, and asks before pushing.

**Cross Debate workflows require a Git repository.** Explicit plan reviews are an exception; non-Git directories do not receive automatic reviews.

## Install

You need macOS or Linux, **Node 22+**, a Git repository for automatic reviews, and at least one signed-in reviewer CLI on `PATH`: `claude`, `codex`,
or `opencode`. One CLI is supported; identical reviewer choices limit model diversity.
GitHub PR reviews also need authenticated `gh`.

Run in your own terminal from any directory:

```sh
npx --yes github:ahmed-hassan19/cross-debate
```

Choose your hosts and reviewers, then confirm **Apply these changes**. The skill and hooks install globally.
Automatic reviews run in every Git project by default and consume reviewer-provider usage; use `scope disable`
to opt out a repository and its linked worktrees. Updating activates existing Git projects unless they already
have an explicit opt-out.
The installer preserves unrelated settings and backs up replaced entries.
Restart your agent. In Codex, review and accept the hook-trust prompt.

The installer asks for two reviewers. The **Lead reviewer** reviews code and pull requests first and makes the
final call on which findings are real; on plans it gives the second independent opinion. Best fit: your most
capable, deep-thinking model with high effort. The **Challenger** questions the Lead's findings and adds missed
problems; on plans it gives the first independent opinion. Best fit: a capable model from a different family than
the Lead, such as Codex when the Lead is Claude; very small models tend to just agree. When you choose reviewers yourself,
you pick them for plans first, then either reuse them for code reviews or choose code reviewers separately, for example
lighter models or lower effort. Model menus start with **CLI default**,
show the newest model of each family plus your existing choice, and end with **Enter another model**.
OpenCode uses `provider/model`. Claude Code lists your account's models through its
[initialize control request](https://code.claude.com/docs/en/agent-sdk/typescript) in safe mode; Codex uses its
[local app-server catalog](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Discovery starts no review turn; if a CLI can't list models, the menu shows built-in versioned IDs.

## Verify

Run from your project, replacing `codex` with `claude`, `cursor`, or `opencode` as appropriate:

```sh
npx --yes github:ahmed-hassan19/cross-debate setup doctor --agent codex
```

Expect reviewer bindings, Git default or explicit opt-out status, and installed hook definitions. Sign-in, native hook trust,
and interactive execution remain manual checks. [Repair setup](docs/setup.md#troubleshooting) if a check fails.

## Your first review

In a Git project using Claude Code or Codex, enter plan mode and describe a small task:

```text
Plan a regression test for the bug we just fixed.
```

Your agent cross-reviews the plan before presenting it. Expect a review outcome and verified decisions about
any findings. After you approve the plan, implementation ends with a reviewed local candidate commit.
Confirmed blockers are fixed before completion. Pushing requires your approval of the exact commit and destination.
A failed, waived, or changed-after-review result is disclosed; completion alone does not mean review passed.

To request a plan review explicitly, including in Cursor, OpenCode, or an opted-out project:

```text
Use cross-debate to review this plan.
```

For a local candidate review, ask: `Use cross-debate's code candidate workflow for these changes.
Verify every finding and keep the candidate commit local.`
To print a standalone review of the working tree:

```sh
npx --yes github:ahmed-hassan19/cross-debate review --local
```

For a GitHub PR:

```sh
npx --yes github:ahmed-hassan19/cross-debate review https://github.com/OWNER/REPO/pull/123 --dry-run
```

Both standalone commands print consolidated findings. PR `--dry-run` **still runs models** and consumes usage;
it suppresses posting. Omit it to post one GitHub `COMMENT` review, without approving or requesting changes.
Standalone findings have no orchestrator verdict. Ask your agent to verify them before acting on them.

## What happens next

Plan review runs two separate, independent passes. Code and PR review use a main reviewer, a debate reviewer
that challenges findings, and a final pass by the main reviewer when there are findings to settle.
In plan and candidate workflows, your agent verifies the evidence and can run up to three rounds.
Agreement between reviewers is not proof.

| Host | Plan gate | Code completion gate | Git commit/push gate |
|---|---|---|---|
| Claude Code | Plan-mode exit | Yes | Yes |
| Codex | Final `proposed_plan` block | Yes | Yes |
| Cursor (experimental) | Manual request | No | Yes |
| OpenCode (experimental) | Manual request | No | Yes |

Hooks are best-effort workflow guards, not a security boundary. Internal hook errors fail open.
Code and PR reviewers use disposable checkouts with project agent configuration removed and a secret scan
of the outgoing diff. Plan reviewers read from the original working directory.
See [operations](skills/cross-debate/references/operations.md) for limitations and recovery.

[Setup, updates, and removal](docs/setup.md) · [Reviewer configuration](docs/configuration.md) ·
[Contributing and support](https://github.com/ahmed-hassan19/cross-debate/blob/main/CONTRIBUTING.md)

## Recorded outcomes

One maintainer's changing workflows, frozen on October 3, 2026. Finding occurrences can repeat across rounds;
these counts do not represent unique bugs or a comparison against another review method.

| Recorded measure | Result |
|---|---|
| Workflow runs | 236 (92 plan, 144 code) |
| Plan rating, first → last round | Median 6 → 8 of 10 across 52 multi-round plans; 81% improved, none declined |
| Plans rated 8 or higher | 25% at first review → 96% after revision (of those 52) |
| Plan runs with accepted findings | 80 of 81 with orchestrator verdicts (99%) |
| Code runs with accepted findings | 43 of 135 with orchestrator verdicts (32%) |
| Code runs that fixed a blocking finding before completion | 11 of 135 (8%) |
| Accepted code findings marked fixed | 55 of 94 occurrences (59%) across 18 runs |
| Accepted blocking code findings marked fixed | 31 of 40 occurrences (78%) across 11 runs |
| Findings the orchestrator discarded after checking | 16% of code and 6% of plan findings; includes 17 code findings both reviewers agreed on |

On the review brief's scale, 5–6 means one blocking gap and 7–8 means minor gaps. Later rounds rate the revised
plan, scored by reviewers who saw the earlier round, so the rating change is not an independent quality measure.

Read the [field report](docs/field-report.md) for the frozen inventory cutoff, coverage, timing, and limitations.
The [aggregate JSON](docs/field-report.json) contains no private source records.

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
The original [mark and banner](docs/branding.md) are included under the same license.
