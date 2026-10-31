### Fixed

- A reading layout chosen while your account's layout could not be loaded (a slow first request right after a deploy, or a dropped connection) is no longer lost: the load is tried again a few times, and the choice is saved once it loads or every attempt failed. A layout loaded just after you changed something on this device no longer puts the old choice back.
- The automatic direct-upload setup under [Admin → Storage](/storage) says it took too long, rather than that the checks failed, when the checks were cut short by its time limit, and it cleans up a token Cloudflare created late on accounts with many API tokens.
- Very long mail (over about 100,000 characters of text) is no longer searched for a one-time code at delivery, so its new-mail notification never carries one; the check now stops before any work on the body.
