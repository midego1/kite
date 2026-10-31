### Added

- "Reload Kite" and "Kite couldn't load" on the loading screen have a folded **Details** section with **Copy details**, for bug reports about a start that hangs. It says how far the start got, for how long the page was visible, how often the screen was mounted, which requests are still open, the slowest files and any frame that blocked the page for more than a second. It holds paths without query strings, times and counts, never message content or addresses. When a page froze, the next load of the tab names the phase it froze at in the browser console and in Details.

### Fixed

- A loading screen that keeps being mounted again now gets "Kite couldn't load" after 30 visible seconds, even while it shows Reload Kite, and the 30-second limit holds again after **Try again** on a failed sign-in check. "Startup is taking longer than expected" counts only the time the tab was visible, so a tab opened in the background no longer shows it the moment you switch to it.
- Some messages could freeze the browser for seconds when opened, listed or replied to: very long runs of dashes before an email address, of `<` in a sender name, of dots or spaces in an attachment name, or of blanks in a colour or before a line break. These are now handled in linear time, as are conversations with thousands of participants. Long runs of broken characters in inbound mail no longer hold up the mail queue.
