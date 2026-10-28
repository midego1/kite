### Fixed

- Cancelling a whole-account import while it is opening a folder no longer leaves that folder shown as running, and the import stops instead of opening the folders after it.
- Two workers can no longer work on the same import at once. A running import renews its hold on the job every minute, so a source server that takes minutes to answer does not lose it, and a worker that did lose it (for example after being stalled) can no longer save progress, extend or clear the new worker's hold, or finish the job.
- Resuming an import whose worker died starts it again within about three minutes, instead of waiting for the old eight-minute hold and the next five-minute check.
- An import that pauses because the database is nearly full keeps its hold on the job until its last fetch has finished.
