# Setup and maintenance

Run installation and settings changes yourself in a terminal. Agents must not install hooks, run `--write`,
or edit real host settings on your behalf. Start with [the README](../README.md#install).

## Update or change a project's review setting

Rerun `npx --yes cross-debate` to update or change reviewers. It preserves unrelated fleet
settings. Use `--version` to see both the installer and installed skill versions.

```sh
npx --yes cross-debate scope enable --cwd "/path/to/project"
npx --yes cross-debate scope status --cwd "/path/to/project"
npx --yes cross-debate setup doctor --agent codex --cwd "/path/to/project"
```

Git projects and separate clones receive automatic reviews by default; `scope disable` opts out a repository and its linked worktrees.
`scope enable` reverses an opt-out. Updating activates existing Git projects unless explicitly opted out. Non-Git directories stay off. Without `--agent`, doctor checks
all hosts. It never starts a reviewer. A single configured CLI is supported; repeated CLI/model choices limit diversity.
Restart the host, check reviewer sign-in yourself, and exercise a small plan/code review to verify native hooks.
For Codex, doctor reports whether Codex trusts each cross-debate hook and prints the required hook feature and writable
root; it does not parse TOML.

To stop automatic reviews, run `npx --yes cross-debate scope disable --cwd "/path/to/project"`.
Finish or explicitly waive any active candidate first. For complete removal, follow the authoritative
[removal steps](../skills/cross-debate/references/operations.md#removal), preserving unrelated settings.

## Troubleshooting

| Check or symptom | Action |
|---|---|
| Missing reviewer or lane | Sign in to the intended CLI, put it on `PATH`, then rerun the installer to choose reviewers. |
| Project override needs trust | Inspect `.delegate/config.json`; remove unintended overrides or explicitly trust the reviewed contents. See [configuration](configuration.md). |
| Code lane uses a project binding | Keep `review-main` and `review-debate` in global fleet settings; remove their project overrides. |
| Hook definition found but no review | Check the Git project scope and restart the host. Definitions alone do not prove execution. |
| `codex hook trust` warns untrusted or modified | Codex skips hooks until trusted, and a changed command needs trusting again. Rerun the installer, or run `/hooks` in Codex and trust the cross-debate hooks. |
| Invalid JSON, TOML, or symlinked settings | Repair the settings file or resolve the symlink before rerunning; installation stops before Apply. |
| Inline Codex writable roots cannot be preserved | Convert the inline object to a `[sandbox_workspace_write]` table, keeping all existing roots. |
| Reviewer failed or was rate limited | Follow [failure recovery](../skills/cross-debate/references/operations.md#reviewer-failure-and-recovery); failure is not a passed review. |

Backups live under `$DEBATE_HOME/install-backups/`, defaulting to `~/.local/share/debate/install-backups/`.
Each backup has a manifest of original paths. Restore only the affected entries after checking for newer edits.
Migration from `debate` preserves review state, lane choices, explicit opt-outs, and old script paths without editing
the checkout behind a skill symlink. Select any host still using the legacy registration on a later installer run.

## Manual installation on Node 18+

The dependency-free skill runtime supports Node 18+. This Claude Code example links a clone into its catalog:

```sh
mkdir -p ~/src ~/.claude/skills
git clone https://github.com/ahmed-hassan19/cross-debate.git ~/src/cross-debate
ln -s ~/src/cross-debate/skills/cross-debate ~/.claude/skills/cross-debate
D="$HOME/.claude/skills/cross-debate/scripts/debate.mjs"
node "$D" setup init
node "$D" setup doctor --agent claude --cwd "/absolute/path/to/project"
```

Install hooks only for hosts where you linked the skill. For Codex, use `.agents/skills` in place of
`.claude/skills`. The wizard prints required TOML changes; merge them into your Codex config, preserving
existing tables and roots. Replace the home-path placeholder or use your actual `DEBATE_HOME`:

```toml
[features]
hooks = true

[sandbox_workspace_write]
writable_roots = ["/absolute/path/to/your-home/.local/share/debate"]
```

Preview individual settings with `node "$D" setup lanes` or `node "$D" setup hooks --agent claude`.
Add `--write` only in your own terminal. OpenCode lanes require `--opencode-model provider/model`.
Restart; in Codex, run `/hooks` and trust the cross-debate hooks; then follow [your first review](../README.md#your-first-review).

The manual wizard also offers optional [ponytail](https://github.com/DietrichGebert/ponytail) complexity
checks and babysit-pr from [review-skills](https://github.com/amElnagdy/review-skills) for posted-review follow-up.
The main installer adds neither. Bundled relays are pinned; other installed copies are ignored unless
`DELEGATE_SKILLS_DIR` selects an override. Maintainers: [source update procedure](https://github.com/ahmed-hassan19/cross-debate/blob/main/CONTRIBUTING.md#updating-the-bundled-delegate-skills).
