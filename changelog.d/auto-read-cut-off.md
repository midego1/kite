### Fixed

- Automatic reading with Anthropic's Claude Haiku 5.5 (and other Claude 5 models) no longer fails with "The AI's answer was cut off" (`cut_off`). These models think by default, and thinking counts against automatic reading's 400-token answer budget, so the budget was spent thinking. Kite now switches thinking off for automatic requests, agent drafts, summaries, one-line summaries and Write with Kite unless a reasoning effort is saved for the model in [Admin → Agent](/agent); Claude Sonnet 5.5 gets its lowest setting, and a model that always thinks (Claude Opus 5.5, Fable) gets effort low with room to think. A cut-off answer is asked once more with double the budget before it fails. Agent reply suggestions with Anthropic also get these settings now. No migration.

### Changed

- **Why?** for cut-off failures on the [Admin overview](/admin) now states what Kite knows: the feature's output cap and how it is made up, whether thinking was on and at which effort, the tokens used, whether Kite already retried, and the setting to change. **Ask AI** sends the same facts with Kite's diagnosis and, for cut-off failures, a note on what the feature asks the model for, so the assistant can answer for Kite instead of guessing. Its summary keeps whole groups: one that does not fit is counted at the end instead of being cut off half-way. Still no email content.
