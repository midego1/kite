### Fixed

- A start whose page stops responding behind the loading screen (bar frozen, kite still swinging, no **Reload Kite**) now says so: after 10 seconds without a sign of life the screen shows "Kite stopped responding. Reload this page to start again." It is drawn by CSS alone, so it appears even when no script can run.
- When a page froze while starting, the next load reports to the server how far it got and which part of the app was rendering last (`boot.previous_load_froze` in the Worker logs), with no message content or addresses, so the cause can be found without copying details by hand.
