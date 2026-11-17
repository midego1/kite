### Fixed

- Write with Kite no longer stops with "The AI's answer was cut off" when you ask for a follow-up on a long conversation. It has more room for the email and the model's thinking, and if an answer still runs out, Kite asks once more with twice the room before it gives up.
- Summaries, translations, one-line summaries and automatic drafts also ask once more when their answer is cut off. Assistant chat and the assistant by email leave room for the model's thinking, so replies are cut off less often. Details under a cut-off error now show the output limit, how thinking was set and what was used.
  ![Write with Kite after a cut-off answer, with Details showing the output cap, thinking, tokens used and the retry](/changelog/2026-11-17-write-with-kite-cut-off-light.webp)
  ![The same Details in the dark theme](/changelog/2026-11-17-write-with-kite-cut-off-dark.webp)
