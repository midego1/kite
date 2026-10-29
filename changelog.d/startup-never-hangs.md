### Fixed

- Reloading Kite, for example from the "Kite was updated" message, no longer leaves the page on the logo with a progress bar that never moves. When the app's files stop arriving without failing, Kite reloads by itself after about 8 seconds of visible time (four times at most within two minutes) and then shows "Kite couldn't load" with a Reload button instead of loading forever. Slow loads that are still receiving files get up to 20 seconds.
- A failed or slow sign-in check while Kite starts is retried twice and then shows "Kite could not reach the server" with Try again and Continue anyway, instead of opening the app without your account (empty admin menus). It also tries again when you return to the tab or come back online. A signed-out session still goes to the sign-in page.
- A failed branding request no longer resets a custom app name and icon to Kite's own.
