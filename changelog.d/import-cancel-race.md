### Fixed

- Cancelling a whole-account import while it is opening a folder no longer leaves that folder shown as running, and the import stops instead of opening the folders after it.
- Resuming a paused import whose worker died mid-batch starts again as soon as its 8-minute lease runs out, instead of also waiting for the next five-minute check.
