# Third-party notices

This skill bundles and adapts MIT-licensed code. Each upstream license is reproduced below.

## delegate-skills

- Source: https://github.com/amElnagdy/delegate-skills
- Pinned commit: `312a234fed363537920708bc38a88fbbc8755175`
- Bundled unmodified under `vendor/delegate-skills/`:
  - `claude-delegate/scripts/relay.mjs`
  - `codex-delegate/scripts/relay.mjs`
  - `opencode-delegate/scripts/relay.mjs`
  - `delegate-setup/scripts/config.mjs`, `lane.mjs`, `implementers.mjs`, `discover.mjs`
- Always used in preference to any installed delegate-skills copy (override with `DELEGATE_SKILLS_DIR`).
- `scripts/lib/common.mjs` (`findScript`, `extractJson`) and `scripts/lib/dispatch.mjs` adapt its relay lookup.

```text
MIT License

Copyright (c) 2026 Ahmed Mohammed (amElnagdy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## review-skills (debate-review)

- Source: https://github.com/amElnagdy/review-skills
- Nearest upstream commit: `c26e4d070300fd6f0047bd855ff8a112decca1d9` (skills/debate-review), **modified locally**:
  GitHub-only forge support, per-role brief contracts (`scripts/lib/briefs.mjs`) and prompt edits, `--ignore-user-config`
  for Codex reviewers, lane resolution in the orchestrator with explicit dials passed to the bundled relays, the `debate.mjs review` entrypoint,
  a secret scan before dispatch, rejection of read-only violations, the diff supplied as files for relays that cannot
  run Git, and decoding of Git-quoted diff paths.
- Adapted files: `scripts/review.mjs`, `scripts/lib/{dispatch,forge,local,validate,render,shell,diff,briefs}.mjs`,
  `assets/prompts/*.md`, `references/schema.md`, `references/comment-format.md`, `references/review.md`.

```text
MIT License

Copyright (c) 2026 Ahmed Mohammed (amElnagdy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
