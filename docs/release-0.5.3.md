# 0.5.3

OpenCode 2 reviewer lanes now send model and variant as `provider/model#variant`; OpenCode 1 keeps `--variant`.
The bundled delegate-skills refresh also brings argument validation, relay hang fixes,
and Windows launch fixes. Existing lanes keep separate model and variant fields.

This release updates reviewer compatibility. It does not include the local OpenCode 2 host hook-generator patch.
Read-only review still relies on the plan agent and change detection; it does not isolate plugins or other host configuration.
