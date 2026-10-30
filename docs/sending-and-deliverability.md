# Sending and deliverability

This page answers three questions people ask before they run an email system: who can send mail through Kite, why it is not an open relay, and what DNS records you need so the mail you send reaches inboxes.

Everything under "What the code does" was checked against the source of this version; the file paths are given so you can check it yourself. Where a provider's behaviour is described, it is the provider's own and may change, so confirm it in their documentation.

## Who can send mail

**Only people who are signed in, or hold an API key an administrator or user created, can send mail. There is no public sign-up.**

- **No self-service registration.** `POST /api/auth/register` (`src/app/api/auth/register/route.ts`) is the first-run endpoint. It answers 403 as soon as one admin account exists (`hasAdminAccount`), and until then it needs the `SETUP_TOKEN` (`requireSetupToken`). In production, setup refuses to run without a `SETUP_TOKEN` of at least 16 characters that is not the example value. After that, accounts are only created by an administrator (`src/app/api/accounts/create.ts`, behind an admin session) or through an API key with the admin `accounts` scope.
- **Every send path needs authentication.** All of them end in `sendEmail` (`src/lib/email/send.ts`):
  - the composer, `POST /api/send`: a session cookie (`requireSessionUser`);
  - the public API, `POST /api/v1/send`: an API key with the `send` scope;
  - JMAP `EmailSubmission` (`src/lib/jmap/identities.ts`): an API key with the `jmap` scope;
  - the AI assistant and MCP: an MCP key can only ask for a send (`request_send`); a signed-in user has to open the review link and confirm the exact content;
  - calendar invitations and automatic out-of-office replies, which run as the mailbox owner.
- **The From address is checked.** `getAuthorizedSenderAddress` (`src/lib/email/sender.ts`) only accepts a mailbox the user can send from (`send_on_behalf` or `send_as` permission, set through mailbox sharing), and the From address has to be that mailbox's own address or one of its aliases. A user cannot send as `ceo@yourdomain` unless that mailbox is theirs or shared with them, and nobody can send as a domain Kite does not host through Kite's own sending. Disabled accounts cannot send.
- **Connected accounts send through their own provider.** In the composer only (`POST /api/send` and its drafts), a user may also send as the address of their own [connected account](external-accounts.md#send-as-the-accounts-address) (`resolveSendIdentity`, `src/lib/external-accounts/identities.ts`): the account's owner, its mailbox, its sign-in address at a known provider (never an "Other" provider's, whose server the user chose), a successful SMTP sign-in, and connected accounts allowed for the install and the user. That mail goes out through the provider's SMTP server with the account's own password (`src/lib/external-accounts/submit.ts`), never through Cloudflare, Resend or SES, so the provider authenticates it and applies its own limits. API keys, MCP, JMAP and automations cannot send as a connected account.
- **No anonymous route sends mail to an address the caller chooses.** The routes that answer without a session are listed in `e2e/support/public-routes.ts`, and a browser test checks that every other API route answers 401 or 403. Of the public ones:
  - sign-in, MFA, password reset and booking send nothing to a caller-supplied address. A password reset goes only to the recovery address stored on the account, at most once a minute per account;
  - the public booking endpoint writes a calendar event and sends no email;
  - the inbound webhooks (`/api/inbound`, `/api/inbound/resend`, `/api/inbound/ses`) only receive mail. They are authenticated by an HMAC signature, a Svix signature and a secret token plus topic check.

If you want a second gate in front of the sign-in page, put the app behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or turn on Turnstile (`TURNSTILE_SECRET_KEY`, see [Deployment](deployment.md)).

## Why Kite is not an open relay

An open relay accepts mail from anyone and delivers it to anyone. Kite does neither.

- **On Cloudflare Workers there is no SMTP service to connect to.** Cloudflare Email Routing receives mail for your domains and hands each message to the Worker for an address you configured. The Worker has no submission port. Outgoing mail only leaves through the authenticated paths above, and then only through the provider you chose for that domain (Cloudflare Email Sending, Resend or Amazon SES), which also authenticates you with your own credentials, or, for a connected account's address, through that account's own provider, signed in as that account.
- **Inbound mail is only accepted for your own addresses.** The Worker resolves the recipient against your domains, mailboxes, aliases and rules, and a message for anything else is rejected. In the self-hosted Docker build the SMTP listener (`server/runtime/smtp.ts`) has `AUTH` disabled, so nobody can log in to it, and `onRcptTo` refuses every recipient that does not resolve to a local domain, mailbox, alias or catch-all with `550`. It never relays to an arbitrary recipient.
- **Forwarding goes where an administrator pointed it.** A forward rule or account-level forwarding sends inbound mail to the destination an admin configured, and nowhere else. On Cloudflare the destination has to be a verified address on your account. Forwarded mail is marked with `X-Kite-Forwarded` so account forwarding cannot loop it; see [The forwarding loop guard](#the-forwarding-loop-guard).
- **Automatic replies are throttled.** An out-of-office reply goes to the sender of a received message, at most once per sender per mailbox every 24 hours, and never to `mailer-daemon`, `postmaster`, `no-reply`, mailing lists, or anything marked `Auto-Submitted`, `Precedence: bulk` or similar. A forged sender address can still receive one reply per day per mailbox, which is the usual trade-off of automatic replies; leave them off if that matters to you.

## The forwarding loop guard

Mail Kite forwards (a forward rule, or account-level forwarding) carries `X-Kite-Forwarded`, and account forwarding skips mail that already carries this install's value, so two of your mailboxes forwarding to each other cannot loop (upstream Mailflare #223).

- **The value is signed.** It is `v1.` and an HMAC-SHA-256 keyed with a server secret: `APP_ENCRYPTION_KEY`, else `INBOUND_WEBHOOK_SECRET`, else `CF_TOKEN`. A sender cannot add `X-Kite-Forwarded: 1` to its own message to keep it from being forwarded. The value is the same on every forward and reveals nothing about the secret. Changing that secret changes the value; mail already forwarded with the old one is then forwarded once more at most.
- **Only without any of those secrets** does Kite write and accept the unsigned `1`, as before. Set `APP_ENCRYPTION_KEY` (see [Deployment](deployment.md)) to get the signed value.
- **The pre-rename name** `X-Mailflare-Forwarded` is accepted only with this install's own value, so the bare `1` older installs wrote no longer stops forwarding.
- **Two installs** forwarding to each other each recognise only their own value. A message that install A forwards to install B, which forwards it back, stops at A: one extra hop instead of a loop. Repeated headers are compared one value at a time, so B's value added beside A's does not hide A's.
- Forward rules themselves are not loop-guarded by the header; they send where an administrator pointed them.

## Limits and abuse protection

| Protection | What it does | Where |
| --- | --- | --- |
| Sending allowance per user | At most **100 messages per rolling hour and 500 per rolling day** for each user, counted over every send path above. A refused send answers HTTP 429 with the reason. Undone sends do not count. Change it with `SEND_LIMIT_PER_HOUR` and `SEND_LIMIT_PER_DAY`; `0` removes a limit. Counting is not atomic, so parallel requests can overshoot by a few messages. | `src/lib/email/send-limits.ts` |
| Recipients per message | At most 50 across To, Cc and Bcc. | `src/lib/email/send.ts` |
| Attachments | The administrator's outgoing limit, 25 MB at most. Cloudflare Email Sending allows 5 MiB per message, so Kite turns larger files into download links; the composer only warns about this when the From domain sends through Cloudflare. | `src/lib/email/attachment-policy.ts`, `cloud-attachment-utils.ts` |
| Sign-in attempts | 20 per minute per IP address on `/api/auth/login` and password reset requests (a Workers rate-limit binding, a fixed window in memory when self-hosted). Optional Turnstile. Optional TOTP two-factor sign-in. | `src/lib/auth/rate-limit.ts` |
| Password reset | One reset email per account per minute. Links are hashed, single use and valid 30 minutes; redeeming one signs the account out everywhere. | `src/lib/auth/password-reset.ts` |
| Cross-site requests | Central CSRF check on every state-changing request. | `src/lib/security/csrf.ts` |
| Public booking | 5 requests per minute per IP address, and no email is sent. | `src/lib/booking/rate-limit.ts` |
| Provider limits | Cloudflare, Resend and SES apply their own quotas, reputation checks and terms to your account; see [Provider limits](#provider-limits). A connected account's provider applies its own to mail sent as that account (Gmail, for example, limits messages per day and 25 MB per message). | the providers |
| Webhooks and audit | Every send is recorded in the audit log (`email.send`) and the `message.outbound` and `message.failed` webhooks fire, so you can watch for a spike. | `src/lib/email/send.ts` |

The allowance is deliberately per user and generous for a person or a small team. It exists so that a stolen session or API key cannot push out thousands of messages before you notice. Raise it if you run newsletters or notifications from Kite, and prefer a dedicated sending service for bulk mail.

### Known gaps

Be aware of these when you decide how much to trust a deployment:

- **API keys are not rate limited on authentication.** Kite relies on the keys being long random values stored hashed. Give each integration its own key with the narrowest scope and mailbox list, and revoke keys you no longer use.
- **The sign-in limit is per IP address.** It slows password guessing from one address, not from many. Use long passwords, turn on two-factor sign-in, and consider Turnstile for a public instance.
- **System email is outside the sending allowance.** Password resets, alert emails and provider test messages are sent directly. Password resets are limited as above; alert emails are capped at one per hour by the alert rules.
- **Account-level forwarding and forward rules relay mail you did not write.** If you forward a catch-all address, spam to that address is forwarded too. Use reject rules and the local spam filter ([Spam protection](spam-protection.md)) to limit that.

### If an account or key is compromised

1. In **Admin → Accounts**, disable the account (a disabled account cannot sign in, use an API key or send) and set a new password, which signs out its existing sessions.
2. Revoke the account's API keys and app passwords.
3. Lower `SEND_LIMIT_PER_HOUR` and `SEND_LIMIT_PER_DAY` while you investigate, and look at the audit log for `email.send` entries.
4. Check **Sent** and the webhook log for what went out, and rotate the provider key (Resend or AWS) if it could have been exposed.
5. Tell your provider if mail went out that you did not intend; they will usually help restore your reputation.

To report abuse of a Kite install you do not run, contact the operator of that install and their provider. To report a security problem in Kite itself, follow [SECURITY.md](../SECURITY.md).

## Your responsibilities as the operator

You run your own Kite, so you are the sender of record. Cloudflare's, Resend's and Amazon's terms and acceptable use policies apply to your account, and local anti-spam law applies to what you send. Keep to opt-in mail, include an unsubscribe route for anything bulk, and do not use Kite to send mail to people who did not ask for it.

## Deliverability: SPF, DKIM and DMARC

Receiving mail servers decide whether to trust your mail from three DNS-based checks:

- **SPF** lists which servers may send for your domain. Only one SPF record may exist per name.
- **DKIM** signs each message with a key published in DNS, so changes in transit are detectable.
- **DMARC** tells receivers what to do when SPF and DKIM both fail to line up with the From domain, and where to send reports.

Large mailbox providers increasingly expect all three and treat missing ones as a spam signal, so set them up before you send anything that matters. Kite shows the state of MX, SPF, DKIM and DMARC for each domain under **Admin → Domains → DNS** and can create what is missing for domains whose DNS is on Cloudflare.

What Kite writes for DMARC is `v=DMARC1; p=none`: monitor only, nothing is rejected or quarantined. That is the safe starting point. It reports nothing by itself, so add a `rua=mailto:` address you read, then tighten the policy once the reports show that all your legitimate mail passes. For example:

```text
_dmarc.example.com  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=r; aspf=r"
```

Kite does not read DMARC reports for you.

### Cloudflare (Email Routing and Email Sending)

Receiving and sending are separate Cloudflare products and both are set up per zone.

1. **Receiving.** Adding a domain with Cloudflare receiving enables Email Routing, which publishes the MX records and the apex SPF record. Check that exactly one `v=spf1` TXT record exists on the apex.
2. **Sending.** Cloudflare Email Sending needs a Workers Paid plan and the domain onboarded under **Compute → Email Service → Email Sending**. Kite creates the sending subdomain from the domain's DNS panel (the DKIM row); Cloudflare publishes the DKIM key and the return-path records on that subdomain. Wait until the domain page reports it as verified before the first real send.
3. **DMARC.** Use **Set up** on the DMARC row, or create the `_dmarc` TXT record shown above yourself.
4. **Check.** Send a message to an address you control at another provider and open **Show original** (Gmail) or view the message source. You want `spf=pass`, `dkim=pass` and `dmarc=pass` in the `Authentication-Results` header. Kite's own **Original Message** dialog shows the same results for mail you receive.

Cloudflare also applies its own limits to Email Sending. Kite enforces the ones that are per message because Cloudflare documents them: 5 MiB per message including attachments (Kite turns larger files into download links), 50 recipients, a 998-character subject and 16 KB of headers. Beyond that, Cloudflare sets daily quotas that start low for new accounts and grow with your sending behaviour, allows 30 Email Routing or Sending domains per zone, and describes Email Service as intended for **transactional email only**, not marketing or bulk mail. Read Cloudflare's [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) and [FAQ](https://developers.cloudflare.com/email-service/reference/faq/) before you rely on it, and use Resend or Amazon SES for heavier sending. Cloudflare takes abuse reports at abuse@cloudflare.com.

### Resend

1. Add the Resend API key under **Admin → Domains** (a full-access key, so Kite can manage the domain; see [Providers](providers.md#resend)).
2. Choose **Resend** for sending on the domain and run **Setup**. Kite creates the domain in Resend and writes the DNS records Resend returns to your Cloudflare zone: a DKIM record for the domain, and an SPF and return-path record on Resend's sending subdomain.
3. Use **Check status** until Resend reports the domain as verified. It can take minutes.
4. Add DMARC as above. Resend signs with its own DKIM key for your domain, so DMARC aligns through DKIM.
5. **Send test email** from the domain card, then read the `Authentication-Results` header.

If you also receive through Resend, the apex MX points to Resend, and Kite shows records that belong to receiving separately. Do not put two SPF records on one name; if you add another sender for the apex, merge it into the existing record.

### Amazon SES

1. Add AWS credentials (access key, secret and region) under **Admin → Domains**. Kite validates them and lists any missing permission with the policy that grants it ([Providers](providers.md#amazon-ses)).
2. Choose **Amazon SES** for sending and run **Setup**. Kite creates the SES identity with Easy DKIM (2048-bit) and publishes the three DKIM CNAME records to your zone. Verification can take a few minutes.
3. **Leave the SES sandbox.** A new AWS account can only send to verified addresses and at a very low volume until you request production access in the SES console. Kite shows a warning row until you do. Request it early; AWS reviews the request and can ask questions about how you collect addresses and handle bounces.
4. **SPF.** Kite does not set a custom MAIL FROM domain, so SES uses Amazon's own return-path and SPF does not align with your From domain. DMARC still passes because DKIM aligns, and that is enough for DMARC. If you want SPF alignment too, configure a custom MAIL FROM domain in SES by hand and add the SPF and MX records AWS gives you on that subdomain.
5. Add DMARC as above, and watch your bounce and complaint rates in the SES console. AWS pauses sending for accounts with high rates.

### New domains and warming up

A new domain with no sending history starts with no reputation. Send low volumes to real, engaged recipients first and raise it over a couple of weeks. Do not buy lists. If you move from another provider, keep the old records until you have confirmed the new ones pass. Reply to messages and ask recipients to reply back: replies are the strongest positive signal.

### Provider limits

| | Cloudflare Email Sending | Resend | Amazon SES |
| --- | --- | --- | --- |
| Needs | Workers Paid plan, domain onboarded in Email Service | API key | AWS account, IAM key |
| Attachments | 5 MiB per message (Kite links larger files) | sent directly, up to the administrator's limit | sent directly, up to the administrator's limit |
| Starting point | daily quota that grows with your reputation; transactional mail only | free tier with a daily cap, see [Cost](../README.md#cost) | sandbox until you request production access |

These are the provider's current rules as documented when this page was written, and they change; see [Cost](../README.md#cost) and each provider's pricing and limits pages.

## Related

- [Sending and receiving providers](providers.md)
- [Deployment and configuration](deployment.md)
- [Spam protection](spam-protection.md) for inbound filtering
- [Troubleshooting](troubleshooting.md)
- [Security policy](../SECURITY.md)
