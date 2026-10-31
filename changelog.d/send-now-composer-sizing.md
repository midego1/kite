### Added

- While a send is held by the undo window, the bar now shows a **Send now** button next to **Undo**, a countdown, and the subject as a link to the queued message in Sent. Send now claims the held message with the same conditional claim the outbound queue uses, so it is never delivered twice and never both sent and undone (`POST /api/messages/{id}/send-now`, for the author only, like Undo; a send waiting for a connected account server's retry keeps its own schedule and answers 409). Sent refreshes when the hold ends. If the provider refuses the message, the bar says "Sending failed" and offers Edit; a send waiting for a connected account's retry cannot be hurried, and a late queue message of the undo window can no longer start a second retry chain.
- Avatars that have loaded once (versioned URLs, which the server caches for a year) no longer flash their blurred preview on the next visit.

### Fixed

- The composer's message body fills the whole composer, so a click anywhere below the text puts the cursor in it, in the floating and the full-page composer.
- The notification service worker (`/kite-sw.js`) is no longer cached by the browser or the CDN (`Cache-Control: no-cache`, `updateViaCache: "none"`), so a new version is picked up on the next load.

Ideas from upstream Mailflare (hieunc229/mailflare, AGPL-3.0): the send bar from #210, the composer sizing from #211, the profile image loading and the PWA update fixes.
