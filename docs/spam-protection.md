# Spam protection

Kite analyzes stored incoming messages locally. The filter combines trusted authentication results, sender relationships, mailbox-scoped reputation, bounded Bayesian token learning, URL checks, message structure, and attachments. No message content or spam intelligence leaves your install, unless the operator turns on the optional [URLhaus and ThreatFox lookups](#urlhaus-and-threatfox-lookups-optional).

Scores range from 0 to 100. Messages scoring 70 or higher move to Spam. Scores from 40 through 69 are recorded as suspicious but remain in their normal Inbox or custom folder. Analysis failures also deliver normally. Automatic replies and new-message notifications are suppressed for messages placed in Spam.

The Spam Filter switch is under **Settings → Inbox → Spam protection** and is enabled by default. Disabling it affects future incoming messages; it does not move or rescan existing mail.

Use **Report spam** to train a message as spam. Use **Not spam** from the Spam folder to train it as legitimate and return it to Inbox. Learning is scoped to the message's mailbox, only explicit user feedback trains the classifier, and changing a decision reverses the previous training first.

## Sender authentication

SPF, DKIM and DMARC results count only when the server that received the message from the internet checked them; a sender can write any `Authentication-Results` header into a message, so Kite never reads one from the message itself.

- **Cloudflare Email Routing** (Kite on Workers, or a self-hosted server behind the [email relay](self-hosting.md#receiving-mail)): Kite uses the topmost `Authentication-Results` header with Cloudflare's `mx.cloudflare.net` authserv-id and ignores any copy below it. It compares the header Cloudflare hands the Worker with the fields of the raw message to find that copy exactly; when the two do not line up, it keeps the copy up to its first comma and, since that may have dropped a failed check, counts its passes as unknown. Through the relay the header counts only when the relay signed the header map (`X-Kite-Headers-Signature`), which relays deployed before that do not do; redeploy the relay to keep the results. Admins see an operational alert while such requests arrive.
- **Amazon SES**: Kite uses the SPF, DKIM and DMARC verdicts SES reports for the message it received, never the message's own headers.
- **The built-in SMTP listener and Resend**: no hop Kite trusts checked the sender, so authentication is unknown. It neither raises nor lowers the score.
- **Imported mail** (Mail import) is not analyzed, so its old headers never count either.

Which results count:

- **SPF** is the check of the envelope sender (`smtp.mailfrom`). Cloudflare also reports a check of the sending server's HELO name, which says nothing about the sender and is ignored.
- **A verified sender** has a passing DMARC check, or a passing DKIM signature from the From address's own domain or a subdomain of the same organization (`mail.example.com` for `example.com`), and no failed check. Any domain can sign its own mail, so another domain's DKIM signature alone does not verify the From address; SES does not report the signing domain, so through SES only DMARC verifies.
- An unverified sender is what automatic reading reasons about: invitations show the unverified-sender warning, Money Watch marks the card unverified, and a saved contact, a sender marked "Not phishing" or an allowlisted sender is not trusted on the From address alone. Mail from one of this install's own domains is trusted only with a passing DMARC check.

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

[URLhaus](https://urlhaus.abuse.ch/) is a free list of websites and files that spread malware, and [ThreatFox](https://threatfox.abuse.ch/) a free list of the servers, domains and files malware uses, both run by abuse.ch. With an abuse.ch Auth-Key (free from [auth.abuse.ch](https://auth.abuse.ch/), and one key works for both lists), Kite asks both about some incoming mail, at the same time. The free abuse.ch API is for non-commercial use; commercial use needs a Spamhaus subscription.

There are two ways to set the key:

- **In the app.** The owner enters it under **Admin → General → Threat lookups** and presses **Save key**. Kite first checks it on both lists: a key either list refuses is not saved (**Key rejected**), and when abuse.ch cannot be reached the key is saved anyway with a warning, so you can check it later with **Test key**. The key is stored in `app_settings.abuse_ch_auth_key`, encrypted with `APP_ENCRYPTION_KEY` when that is set (like the Resend key), and is never shown or sent back to the browser again. It is part of the database backup in that stored form, so a restore needs the same `APP_ENCRYPTION_KEY`. **Remove key** deletes it. Saving needs migration 0068.
- **As a secret.** The operator sets `URLHAUS_AUTH_KEY` (or `ABUSE_CH_AUTH_KEY`, another name for the same key; `URLHAUS_AUTH_KEY` wins when both are set) in the Worker's secrets or the server's environment.

A secret takes precedence over a key saved in Kite. While one is set, the card shows **Key set in Cloudflare (secret)** (on Node/Docker, **Key set in an environment variable (secret)**) and hides the field; otherwise it shows **Key saved in Kite** or **No key**. **Admin → General → Threat lookups** shows whether lookups are on, and the owner can press **Test key** there with either kind of key: Kite looks up `example.com` once on each list and shows **Key works**, **Key rejected** or **abuse.ch unreachable** for each. There is no other switch: remove the saved key and the secret to turn lookups off. If `APP_ENCRYPTION_KEY` changes, a saved key can no longer be read, lookups stop, the Worker logs `spam.threat_lookup_key_unreadable` and the card asks you to save the key again.

- **Only risky mail.** Kite asks only when the message already shows a risk: an attached web page or program, a login or payment lure, a misleading link, a failed SPF, DKIM or DMARC check, a request to get past the filter, or enough smaller signs together.
- **Not your correspondents.** Mail from a saved contact or someone you have written to is not looked up, unless its authentication failed and the From may be forged. Mail from a blocked sender is decided before any lookup.
- **What is sent to URLhaus.** Up to five links (links inside attached web pages first) and the SHA-256 hashes of up to three attachments, never the files themselves. Inline images are left out. Links are sent as they are, so a personal link can reveal who received it.
- **What is sent to ThreatFox.** Only the host names of those links (as in `files.example.net` and `example.net`, or an IP address with its port), at most five, and the same attachment hashes. Paths and query strings are not sent. Each name and hash is looked up once.
- **What it changes.** A link on URLhaus adds 40 to the score, an attachment on URLhaus 50; ThreatFox adds the same. When both lists match a message's links, or both match its attachments, the second adds only 10, so one bad link or file is not counted twice in full. Every match shows as a reason on the phishing warning. A lookup that fails or takes longer than 3 seconds counts as not listed, so an outage never holds mail back.
- **A rejected key is logged.** When abuse.ch refuses the key, the Worker logs `spam.threat_lookup_key_rejected` with the list's name, never the key or the links. Mail is delivered as if nothing were listed.
