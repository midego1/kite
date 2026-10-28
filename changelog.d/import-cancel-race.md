### Fixed

- Cancelling a whole-account import while it is opening a folder no longer leaves that folder shown as running, and the import stops instead of opening the folders after it.
- A paused or resumed import can no longer get a second worker while a very slow IMAP command is still running: a running import now renews its hold on the job every minute, and a slow server no longer outlasts it.
- Resuming an import whose worker died starts it again within about three minutes, instead of waiting for the old eight-minute hold and the next five-minute check.
- An import that pauses because the database is nearly full keeps its hold on the job until its last fetch has finished.
