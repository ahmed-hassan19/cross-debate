# debate-review JSON contracts

Three documents flow through one run. Each implementer returns its document as the only fenced
JSON block in its final message. The script extracts it and checks it against the contract below.
Anything that fails the check stops the run. Nothing gets posted.

The script reads sections 1, 2, and 3 below by heading order and pastes them into the briefs. Don't
reorder them or add a `##` heading above section 3.

## 1. `debate-review.findings.v1`, main reviewer to script

```json
{
  "schema": "debate-review.findings.v1",
  "head": "<head sha reviewed>",
  "verdict": "approve | needs-attention",
  "summary": "one-paragraph ship/no-ship read",
  "findings": [
    {
      "id": "F1",
      "file": "src/foo.py",
      "line_start": 42,
      "line_end": 48,
      "severity": "blocking | non-blocking",
      "axis": "correctness | security | spec | standards | tests | docs | efficiency",
      "claim": "what is wrong, one sentence",
      "evidence": "why: the code path, the quoted line, the spec line",
      "recommendation": "concrete change",
      "suggestion": "optional: exact replacement text for line_start..line_end",
      "confidence": 0.0
    }
  ]
}
```

- `id` is `F<n>` for the main reviewer and `D<n>` for findings the debate reviewer adds.
- `line_start` and `line_end` must be lines on the new side of the PR diff, because GitHub can only
  anchor comments there. If the problem is outside the diff, anchor the nearest changed line
  and say so in `evidence`.
- Blocking requires an evidence-backed, reachable trigger and a material failure of current requirements
  or safety guarantees. A real defect that is rare in supported use and low in impact is non-blocking.
  Rarity alone never makes authorization bypass, sensitive-data exposure, incorrect financial operations,
  or irreversible data loss non-blocking.
- `confidence` is 0 to 1. Findings under `min_confidence` (default 0.5) are dropped before debate.
- `efficiency` findings are always non-blocking. The script turns a blocking one non-blocking, drops one
  from the debate reviewer's `new_findings`, and records a warning in the run log.
- `suggestion` is optional and must be a string. It is posted as a GitHub suggestion only when the final
  ruling is `agreed`, the debate reviewer confirmed the finding (or it is a `D*`), the final stage kept
  the same file and lines without vetoing it (`"suggestion": null`), and the inline anchor covers exactly
  those lines. A debate `confirm` vouches for the replacement too. The final stage never supplies one.

## 2. `debate-review.debate.v1`, debate reviewer to script

```json
{
  "schema": "debate-review.debate.v1",
  "head": "<same sha>",
  "verdicts": [
    { "id": "F1", "verdict": "confirm | refute | downgrade", "reason": "one sentence", "evidence": "file:line or quoted code" }
  ],
  "new_findings": [ /* same shape as findings[], ids D1, D2, ... */ ]
}
```

- Every `F*` id gets exactly one explicit verdict. A missing verdict fails the review; silence never counts as confirmation.
- Blocking requires an evidence-backed, reachable trigger and a material failure of current requirements
  or safety guarantees. A real defect that is rare in supported use and low in impact is non-blocking.
  Rarity alone never makes authorization bypass, sensitive-data exposure, incorrect financial operations,
  or irreversible data loss non-blocking.
- `refute` when a guard eliminates the alleged defect or no evidence-backed trigger remains. Name the
  guard or unsupported premise; an accepted refutation calls for withdrawal in the final pass.
- `downgrade` can correct severity, confidence, or a suggestion; state which correction is justified.
  Lower severity only when the remaining defect falls below the blocking bar. A confidence-only
  concession preserves justified severity while an evidence-backed trigger remains. If the defect
  remains blocking but its suggested patch is wrong, preserve blocking severity and flag the invalid
  suggestion for suppression in the final pass.
- `refute` must carry evidence. A bare "I disagree" is recorded but weighted as `downgrade`.
- `new_findings` is a gap sweep, not a second review. Blocking only, with a named trigger. Entries
  below `min_confidence` are dropped the same way the main findings are. Zero new findings is the
  expected outcome on most PRs.

## 3. `debate-review.final.v1`, main reviewer (rebuttal pass) to script, then to the PR

```json
{
  "schema": "debate-review.final.v1",
  "head": "<same sha>",
  "summary": "final ship/no-ship read after debate",
  "findings": [
    {
      "id": "F1",
      "status": "agreed | contested | withdrawn",
      "severity": "blocking | non-blocking",
      "file": "...", "line_start": 0, "line_end": 0,
      "claim": "...", "evidence": "...", "recommendation": "...",
      "debate_note": "one line: what the challenge said and why the finding was kept, dropped, or changed"
    }
  ]
}
```

- Blocking requires an evidence-backed, reachable trigger and a material failure of current requirements
  or safety guarantees. A real defect that is rare in supported use and low in impact is non-blocking.
  Rarity alone never makes authorization bypass, sensitive-data exposure, incorrect financial operations,
  or irreversible data loss non-blocking.
- `agreed`: the defect is retained, including an accepted or rejected severity downgrade. An accepted
  severity downgrade changes severity; a rejected one keeps justified severity and explains the
  disagreement in `debate_note`. Both remain eligible for posting under `--contested drop`.
- `contested`: only an `F*` held against an evidenced refutation. Posted with a `contested` tag, or
  dropped with `--contested drop`. A severity, confidence, or suggestion disagreement alone is not contested.
- `withdrawn`: a guard eliminates the alleged defect or no evidence-backed trigger remains. Name the
  guard or unsupported premise in `debate_note`. Never posted, kept in the run log.
- A confidence-only concession preserves justified severity while the blocking bar still holds; explain
  it in `debate_note`. The final schema has no confidence field; do not invent a numeric confidence update.
- An accepted suggestion-only correction preserves justified severity and sets `"suggestion": null`
  when the original replacement is invalid. A wrong patch does not make a blocking defect non-blocking.
- `D*` findings can only end as `agreed` or `withdrawn`. A `D*` the main reviewer rejects with evidence
  is `withdrawn` with the objection in `debate_note`. It is never `contested`, so a rejected claim from
  the second model is never posted. A `D*` that duplicates an `F*` is `withdrawn` with `debate_note`
  `"duplicate of F<n>"`.

## Run log

`<out-dir>/run.json` keeps all three documents plus timings, implementers, lanes, and the posted
comment ids, keyed by `owner/repo#N@head`. Re-running on the same head does nothing unless `--force`.
