# Reviewer configuration

Use `npx --yes cross-debate` to change reviewers. The wizard merges your choices while
preserving unrelated lanes. Settings live in `~/.config/delegate-skills/config.json`, or under `XDG_CONFIG_HOME`.

A lane names a role; its `implementer` selects the reviewer CLI. Your seat is your host agent.

The installer calls the two reviewers the **Lead reviewer** (`review-main` and `plan-debate`) and the
**Challenger** (`review-debate` and `plan-main`). When you choose reviewers yourself, it asks for the plan lanes first,
then lets you reuse them for the code lanes or choose the code lanes separately.

| Lane | Installer role | Role |
|---|---|---|
| `plan-main` | Challenger | First independent plan-review pass |
| `plan-main-<seat>` | Challenger | Overrides that first pass for one host |
| `plan-debate` | Lead reviewer | Second independent plan-review pass |
| `review-main` | Lead reviewer | Main and final code/PR reviewer |
| `review-debate` | Challenger | Challenges code/PR findings and can add findings |

Best fit: give the Lead reviewer your most capable, deep-thinking model with high effort, since it does the most
work. Give the Challenger a capable model from a different family; a lighter model saves usage, but very small
models tend to just agree.

Omitting `model` uses Claude Code or Codex's CLI default. OpenCode requires an explicit `provider/model`.
`effort` is the Claude/Codex reasoning dial; `variant` is OpenCode's provider-specific dial. Omit either to
use its CLI default. The installer words `default` and `none` mean omission, not literal values to save.
The model and dial must be supported by your signed-in provider; schema validation alone cannot check that.

## Examples

These are complete `delegate-fleet.v1` documents, validated by the bundled validator:

- [Two CLI reviewers](../examples/two-cli.json), Claude Code and Codex with their default models.
- [One CLI](../examples/single-cli.json), two separate passes using Codex. Identical choices reduce model diversity.
- [OpenCode model template](../examples/opencode-template.json), replace `provider/model-id` and `variant-name`
  with values from your OpenCode configuration before use.
- [Seat override](../examples/seat-override.json), changes only Claude Code's first plan reviewer in this example.

Merge only the intended lane entries into your existing settings; do not replace a fleet file containing
other lanes with an example. To validate a draft from a clone without changing settings:

```sh
node skills/cross-debate/vendor/delegate-skills/delegate-setup/scripts/config.mjs validate examples/two-cli.json
```

## Precedence and project trust

Global lanes load first. `.delegate/config.json` replaces an entire lane of the same name, including omitted
fields. `plan-main-<seat>` then wins by presence over `plan-main`; an invalid override fails instead of falling back.
Project plan bindings require explicit trust of that exact file digest. Inspect the project file and use the
bundled delegate-setup config tool's `write --scope project --cwd <project> <reviewed-file>` in your own terminal
only after checking all entries; it writes the file and records trust. Later edits invalidate that trust.

Code-review lanes must have **global bindings**, even when a project file is trusted, because disposable
review checkouts do not carry project trust. One-off `--main-lane`/`--debate-lane` selections obey this restriction.
Use `setup doctor --agent <host> --cwd <project>` to see effective bindings and repair hints.

| Setting or path | Purpose |
|---|---|
| `DEBATE_HOME` | Plan/code state and receipts, default `~/.local/share/debate` |
| `DEBATE=off` | Explicitly disable hooks for a session |
| `DELEGATE_SKILLS_DIR` | Override the bundled delegate-skills scripts |
| `~/.cache/debate-review/` | Standalone PR/local review artifacts |

`npx --yes cross-debate stats --since 30d` shows local review statistics.
Claude's native permission allowlist matches literal paths; `setup hooks --agent claude` prints entries for
the invoked catalog path and its resolved path. Workflow details stay in [operations](../skills/cross-debate/references/operations.md).
