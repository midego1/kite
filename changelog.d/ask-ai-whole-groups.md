### Fixed

- **Ask AI** for failed AI requests on the [Admin overview](/admin) no longer leaves out cut-off failures on a busy day. The notes on what a feature asks the model for now come only with cut-off failures, where they explain the output cap, instead of with the first group that names the feature. The summary keeps whole groups: one that does not fit is counted in a closing line instead of being cut off half-way, and a later group may take its place. No migration.
