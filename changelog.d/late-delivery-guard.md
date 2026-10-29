### Fixed

- A send that was moved to Drafts after it stalled (**Move to Drafts** on a message stuck in "Sending…") can no longer be turned back into a sent or failed message by the worker that was still delivering it. The message stays the draft it is, the job keeps the state recovery gave it, no "message failed" webhook is sent for it, and a worker that finds its send already taken back does not deliver at all. A delivery that still went out is recorded in the audit log.
