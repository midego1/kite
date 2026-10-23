# Spam protection

Kite analyzes stored incoming messages locally. The filter combines trusted authentication results, sender relationships, mailbox-scoped reputation, bounded Bayesian token learning, URL checks, message structure, and attachments. No message content or spam intelligence leaves your install, unless the operator turns on the optional [URLhaus and ThreatFox lookups](#urlhaus-and-threatfox-lookups-optional).

Scores range from 0 to 100. Messages scoring 70 or higher move to Spam. Scores from 40 through 69 are recorded as suspicious but remain in their normal Inbox or custom folder. Analysis failures also deliver normally. Automatic replies and new-message notifications are suppressed for messages placed in Spam.

The Spam Filter switch is under **Settings → Inbox → Spam protection** and is enabled by default. Disabling it affects future incoming messages; it does not move or rescan existing mail.

Use **Report spam** to train a message as spam. Use **Not spam** from the Spam folder to train it as legitimate and return it to Inbox. Learning is scoped to the message's mailbox, only explicit user feedback trains the classifier, and changing a decision reverses the previous training first.

Kite accepts mail before this analysis. Forward-only routing occurs before stored-message filtering and is outside the filter's v1 scope.

## Phishing signs

Besides links that show one address and open another, bare IP addresses (IPv4 and IPv6) and look-alike characters in links, and failed SPF, DKIM or DMARC checks, the filter looks for these signs. With automatic reading on, they also become the reasons on the red phishing warning in the reader.

- **Attached web pages.** An HTML or SVG attachment opens in a browser and can show a fake login page. It counts more when the message or the file name presents it as an invoice, statement, scan or other document (`invoice.pdf.html`). Inline images are not counted.
- **Inside those pages.** Kite reads the text of up to five attached pages: a password field or a form that sends to a website, and hidden code or an automatic redirect, each add to the score. Links inside the pages get the same link checks as links in the message.
- **Programs and disk images.** Attachments such as `.exe`, `.js`, `.scr`, `.iso` or `.lnk` files.
- **Look-alike link hosts.** A link host written in punycode (`xn--`) counts more when it decodes to letters that imitate Latin ones, such as Cyrillic or Greek letters mixed with Latin, than when it is an ordinary international domain name.
- **URL shorteners.** A link through a shortener such as bit.ly hides where it goes. This adds a little to the score and, on its own, is not a reason for a phishing warning; it only lets the model's suspicion count.

A link is misleading only when it opens a different domain than the one it shows. One that shows `example.com` and opens `mail.example.com`, or a newsletter service's tracking redirect whose target is the address it shows, is not.
- **Requests to get past the filter.** Text that asks you to whitelist the sender, never block it or mark the message as safe or not spam. Asking to be added to your address book alone does not count.

## Report phishing

**Report phishing** is in an open message's **More actions** menu, in the list's **Move to** and **More** menus for selected messages, and on the phishing warning. After you confirm, Kite:

- moves the message to Spam;
- learns from it like a spam report, with three times the weight on what makes the campaign recognisable, so the next copy starts with a poor reputation;
- blocks the sender, so their next mail goes straight to Trash;
- closes the phishing warning for the message.

A sender you saved as a contact or have written to is not blocked, and neither is an address on one of the install's own domains: a phishing message can forge such a From, and blocking it would hide the real person's mail. The message still moves to Spam and still trains the filter. The toast after a report says which senders were blocked and why any were not. There is no Undo. **Not spam** moves a message back and reverses its training, but a block, like one from **Block contact**, cannot be lifted from the app yet.

<a id="urlhaus-lookups-optional"></a>

## URLhaus and ThreatFox lookups (optional)

[URLhaus](https://urlhaus.abuse.ch/) is a free list of websites and files that spread malware, and [ThreatFox](https://threatfox.abuse.ch/) a free list of the servers, domains and files malware uses, both run by abuse.ch. When the operator sets the `URLHAUS_AUTH_KEY` secret (a free Auth-Key from abuse.ch, which works for both lists), Kite asks both about some incoming mail, at the same time. `ABUSE_CH_AUTH_KEY` is accepted as another name for the same key; when both are set, `URLHAUS_AUTH_KEY` is used. **Admin → General → Threat lookups** shows whether lookups are on, and the owner can press **Test key** there: Kite looks up `example.com` once on each list and shows **Key works**, **Key rejected** or **abuse.ch unreachable** for each. There is no switch in the app: remove the secret to turn lookups off.

- **Only risky mail.** Kite asks only when the message already shows a risk: an attached web page or program, a login or payment lure, a misleading link, a failed SPF, DKIM or DMARC check, a request to get past the filter, or enough smaller signs together.
- **Not your correspondents.** Mail from a saved contact or someone you have written to is not looked up, unless its authentication failed and the From may be forged. Mail from a blocked sender is decided before any lookup.
- **What is sent to URLhaus.** Up to five links (links inside attached web pages first) and the SHA-256 hashes of up to three attachments, never the files themselves. Inline images are left out. Links are sent as they are, so a personal link can reveal who received it.
- **What is sent to ThreatFox.** Only the host names of those links (as in `files.example.net` and `example.net`, or an IP address with its port), at most five, and the same attachment hashes. Paths and query strings are not sent. Each name and hash is looked up once.
- **What it changes.** A link on URLhaus adds 40 to the score, an attachment on URLhaus 50; ThreatFox adds the same. When both lists match a message's links, or both match its attachments, the second adds only 10, so one bad link or file is not counted twice in full. Every match shows as a reason on the phishing warning. A lookup that fails or takes longer than 3 seconds counts as not listed, so an outage never holds mail back.
- **A rejected key is logged.** When abuse.ch refuses the key, the Worker logs `spam.threat_lookup_key_rejected` with the list's name, never the key or the links. Mail is delivered as if nothing were listed.
