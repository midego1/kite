### Fixed

- Applying database updates no longer looks like the page has hung. **Update database** (Admin overview) and **Apply now** (the mailbox notice) turn into a busy "Updating database…" button and show the steps (the safety backup, then the updates one by one with how many are done), a progress bar and a running timer, and the browser warns before you close or leave the page meanwhile. When it finishes you see how many updates were applied, whether a safety backup was saved and how long it took; a failure or a backup restore in progress is explained, with the button available again.
