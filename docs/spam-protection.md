# Spam protection

Kite analyzes stored incoming messages locally. The filter combines trusted authentication results, sender relationships, mailbox-scoped reputation, bounded Bayesian token learning, URL checks, message structure, and attachments. No message content or spam intelligence leaves your install, unless the operator turns on the optional [URLhaus lookups](#urlhaus-lookups-optional).

Scores range from 0 to 100. Messages scoring 70 or higher move to Spam. Scores from 40 through 69 are recorded as suspicious but remain in their normal Inbox or custom folder. Analysis failures also deliver normally. Automatic replies and new-message notifications are suppressed for messages placed in Spam.

The Spam Filter switch is under **Settings → Inbox → Spam protection** and is enabled by default. Disabling it affects future incoming messages; it does not move or rescan existing mail.

Use **Report spam** to train a message as spam. Use **Not spam** from the Spam folder to train it as legitimate and return it to Inbox. Learning is scoped to the message's mailbox, only explicit user feedback trains the classifier, and changing a decision reverses the previous training first.

Kite accepts mail before this analysis. Forward-only routing occurs before stored-message filtering and is outside the filter's v1 scope.

## Phishing signs

Besides links that show one address and open another, bare IP addresses and look-alike characters in links, and failed SPF, DKIM or DMARC checks, the filter looks for these signs. With automatic reading on, they also become the reasons on the red phishing warning in the reader.

- **Attached web pages.** An HTML or SVG attachment opens in a browser and can show a fake login page. It counts more when the message or the file name presents it as an invoice, statement, scan or other document (`invoice.pdf.html`). Inline images are not counted.
- **Inside those pages.** Kite reads the text of up to five attached pages: a password field or a form that sends to a website, and hidden code or an automatic redirect, each add to the score. Links inside the pages get the same link checks as links in the message.
- **Programs and disk images.** Attachments such as `.exe`, `.js`, `.scr`, `.iso` or `.lnk` files.
- **Requests to get past the filter.** Text that asks you to whitelist the sender, never block it or mark the message as safe or not spam. Asking to be added to your address book alone does not count.

## Report phishing

**Report phishing** is in an open message's **More actions** menu, in the list's **Move to** and **More** menus for selected messages, and on the phishing warning. After you confirm, Kite:

- moves the message to Spam;
- learns from it like a spam report, with three times the weight on what makes the campaign recognisable, so the next copy starts with a poor reputation;
- blocks the sender, so their next mail goes straight to Trash;
- closes the phishing warning for the message.

A sender you saved as a contact or have written to is not blocked, and neither is an address on one of the install's own domains: a phishing message can forge such a From, and blocking it would hide the real person's mail. The message still moves to Spam and still trains the filter. The toast after a report says which senders were blocked and why any were not. There is no Undo. **Not spam** moves a message back and reverses its training, but a block, like one from **Block contact**, cannot be lifted from the app yet.

## URLhaus lookups (optional)

[URLhaus](https://urlhaus.abuse.ch/) is a free list of websites and files that spread malware, run by abuse.ch. When the operator sets the `URLHAUS_AUTH_KEY` secret (a free Auth-Key from abuse.ch), Kite asks URLhaus about some incoming mail. **Admin → General → Threat lookups** shows whether lookups are on. There is no switch in the app: remove the secret to turn them off.

- **Only risky mail.** Kite asks only when the message already shows a risk: an attached web page or program, a login or payment lure, a misleading link, a failed SPF, DKIM or DMARC check, a request to get past the filter, or enough smaller signs together.
- **Not your correspondents.** Mail from a saved contact or someone you have written to is not looked up, unless its authentication failed and the From may be forged. Mail from a blocked sender is decided before any lookup.
- **What is sent.** Up to five links (links inside attached web pages first) and the SHA-256 hashes of up to three attachments, never the files themselves. Inline images are left out. Links are sent as they are, so a personal link can reveal who received it.
- **What it changes.** A listed link adds 40 to the score, a listed attachment 50, and both show as reasons on the phishing warning. A lookup that fails or takes longer than 3 seconds counts as not listed, so an outage never holds mail back.
