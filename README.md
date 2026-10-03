# cross-debate

Cross-agent review for plans, code, and pull requests.
Your coding agent coordinates two reviewers, verifies findings in plan and code workflows, and asks before pushing.

## Install

You need macOS or Linux, **Node 22+**, Git, and at least one signed-in reviewer CLI on `PATH`: `claude`, `codex`,
or `opencode`. One CLI is supported; identical reviewer choices limit model diversity.
GitHub PR reviews also need authenticated `gh`.

Run in your own terminal, from your project's directory:

```sh
npx --yes github:ahmed-hassan19/cross-debate
```

Choose your hosts and reviewers, opt into automatic reviews for this project, and confirm **Apply these changes**.
The skill and hooks install globally; each project enrolls separately. Reviews consume your reviewer-provider usage.
The installer preserves unrelated settings and backs up replaced entries.
Restart your agent. In Codex, review and accept the hook-trust prompt.

## Verify

Run from your project, replacing `codex` with `claude`, `cursor`, or `opencode` as appropriate:

```sh
npx --yes github:ahmed-hassan19/cross-debate setup doctor --agent codex
```

Expect reviewer bindings, project enrollment, and installed hook definitions. Sign-in, native hook trust,
and interactive execution remain manual checks. [Repair setup](docs/setup.md#troubleshooting) if a check fails.

## Your first review

In an enrolled Claude Code or Codex project, enter plan mode and describe a small task:

```text
Plan a regression test for the bug we just fixed.
```

Your agent cross-reviews the plan before presenting it. Expect a review outcome and verified decisions about
any findings. After you approve the plan, implementation ends with a reviewed local candidate commit.
Confirmed blockers are fixed before completion. Pushing requires your approval of the exact commit and destination.
A failed, waived, or changed-after-review result is disclosed; completion alone does not mean review passed.

To request a plan review explicitly, including in Cursor, OpenCode, or an unenrolled project:

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
