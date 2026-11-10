# Sending and receiving providers

Kite keeps your mail data in your own D1 database and R2 bucket (or SQLite and local files when self-hosted). What carries mail over the wire is a choice you make **per domain**, separately for receiving and for sending:

| | Cloudflare | Resend | Amazon SES |
|---|---|---|---|
| **Receiving** | Email Routing (the default) | `email.received` webhook | S3 + SNS notification |
| **Sending** | Cloudflare Email Sending | Resend API | SESv2 API |

DNS stays on Cloudflare for every combination: Kite writes the records for whichever provider you pick. A domain can also be **receive-only** (sending: Not selected) or **send-only** (receiving: Not selected).

Open **Admin → Domains**, expand a domain, and use the **Setup receiving email** and **Setup sending email** sections. Each provider is a card with a switch. Turning a switch on selects that provider and shows its setup; the icon on the left is a green check when it is fully set up and an amber triangle when it is not.

> Selecting a provider does not change DNS. The Setup button inside the provider's card does. This lets you prepare a new provider while the old one keeps working.

Mail accounts at other providers (Gmail, iCloud, Fastmail, Yahoo and other IMAP providers) are not domains: you connect them per user under **Settings → Connected accounts**, with the provider's servers filled in from a preset and an app password. Outlook.com, Hotmail and Microsoft 365 accounts sign in with Microsoft instead, once the owner has [set up Microsoft sign-in](#microsoft-sign-in-for-connected-accounts). See [Connected accounts](external-accounts.md).

## Choosing at add time

**New domain** asks which service receives the domain's mail (**Receive mail with**) and which sends it (**Send mail with**), each a dropdown of Cloudflare, Resend, Amazon SES or Not selected. Cloudflare Email Routing and the Cloudflare sending subdomain are only enabled on the zone for the Cloudflare choice. For Resend or SES the domain is added without touching either; finish from the domain page once the credentials are in. The same choices are available over the API as `receivingProvider` and `sendingProvider` (see [API](api.md#domain-management)).

### Skipping DNS setup

**Skip DNS setup** (in **New domain**, in onboarding and in the first-run domain step) adds the domain now and leaves its DNS for later: Kite does not look the domain up on Cloudflare, does not check or change any record, and selects no receiving or sending provider. Mail does not arrive until the records are set. Ported from upstream Mailflare #152.

Until then, admins who can manage domains see a notice in the sidebar (over the page on phones) naming the domain, with **Review** (the Domains page) and **Mark as done**, which clears the reminder once the records are in place; the domain shows **DNS skipped** on the Domains page. On an install with Cloudflare credentials, the first Setup on the domain page (a DNS record, Cloudflare Email Routing or Cloudflare Email Sending) finds the domain's Cloudflare zone and attaches it; it is refused when the zone belongs to another account on this install or is not on the configured Cloudflare account. On a self-hosted install without Cloudflare credentials, create the records where the domain's nameservers are hosted.

## Resend

Resend uses one **API key**, shared by every domain that uses it. Create it at [resend.com/api-keys](https://resend.com/api-keys).

- A **full-access** key lets Kite add the domain to Resend, write its DNS records to the Cloudflare zone, verify it, and (for receiving) register the webhook.
- A **sending-only** key can send, but Resend refuses it for domain and webhook management, so you add the domain at [resend.com/domains](https://resend.com/domains), create its records yourself, and use **Send test email** to confirm. Kite says so in the card instead of failing.

The key is checked against Resend when you save it. It can also come from the `RESEND_API_KEY` secret, which is used when no key is saved in the app. Only the primary administrator can change it.

**Sending.** Setup creates the domain in Resend, publishes its DKIM and SPF records, and asks Resend to verify. Verification is Resend's own status: it can stay `pending` for a few minutes after the DNS is added, and **Check status** re-asks Resend without creating anything new. Replies thread correctly because Kite sets its own `Message-ID`.

**Receiving.** Setup enables the receiving capability on the domain, points the apex MX at Resend, and registers one webhook for `email.received` at `/api/inbound/resend`. The webhook is authenticated with the Svix signing secret Resend returns when it is created; Kite stores that secret, which is why a webhook it did not create itself is replaced. For each event Kite fetches the message, downloads the raw MIME and runs it through the normal inbound pipeline. It delivers to the addresses in the message's `received_for`, `to`, `cc` and `bcc` on domains that receive through Resend, at most 50 per message: Resend does not say which of them are envelope recipients, and a mailing list or a forward may name the mailbox only in `received_for`. An address on a domain that receives elsewhere is not delivered, and the drop is logged. A retried webhook does not deliver a second copy, nor does a second webhook that carries the same Resend email id. Resend must be able to reach your app, so `APP_URL` has to be a public HTTPS address.

## Amazon SES

Create an IAM user with programmatic access, then enter its **access key ID**, **secret access key** and **region** in the SES card. Kite validates them before saving: it proves the identity with STS, then makes a harmless call to each service it needs, and lists every permission the key lacks. Credentials can also come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`.

The key needs this policy (the card shows it too, with only the missing parts called out):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sts:GetCallerIdentity", "ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRuleSet", "ses:SetActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DescribeReceiptRule", "ses:DeleteReceiptRule"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["sns:ListTopics", "sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:CreateBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:ListBucket", "s3:GetObject", "s3:DeleteObject"], "Resource": "*" }
  ]
}
```

Only the sending statements are needed if you use SES just for sending.

**Sending.** Setup creates the domain's SES identity, publishes its three DKIM CNAME records to the Cloudflare zone, and tracks verification. New AWS accounts start in the **SES sandbox**, where SES delivers only to verified addresses; Kite shows a warning row until you request production access in the SES console. Replies thread because Kite stores the Message-ID SES assigns (`<id@email.amazonses.com>` in us-east-1, `<id@region.amazonses.com>` elsewhere).

**Receiving.** SES can only receive in some regions (for example us-east-1, us-west-2 and eu-west-1); Kite rejects the others. Setup creates, idempotently:

1. an S3 bucket (`mailflare-inbound-<account>-<region>`) that only SES may write to, with a one-day expiry for leftovers (best effort);
2. an SNS topic that only SES may publish to, subscribed to `/api/inbound/ses` with a secret token in the URL;
3. a receipt rule for the domain in the account's active rule set (Kite creates and activates `mailflare-inbound` only if the account has none, and otherwise adds its rule beside yours);
4. the MX record `inbound-smtp.<region>.amazonaws.com`.

Each message is read from your own bucket, handed to the normal inbound pipeline, and deleted. SES's SPF, DKIM and DMARC verdicts count only when the SNS notification's signature verifies ([Sender authentication](spam-protection.md#sender-authentication)). SES's virus scan is enabled and infected messages are dropped. `APP_URL` has to be a public HTTPS address so SNS can reach the endpoint. The bucket and topic are shared by all SES domains; **Clean up** removes only the domain's rule and MX, so Kite never deletes resources another domain may still use.

## MX records and switching receiving provider

Only one service can own a domain's MX records. When a provider's Setup finds MX records for something else (including Cloudflare Email Routing's), it stops and shows them, and replaces them only after you confirm. Confirming means the previous service stops receiving mail for that domain.

Per-address routes to the Kite Worker are only created for domains that receive through Cloudflare, and are recreated when you set Cloudflare up again.

## Cleaning up the provider you left

If a provider you are not using still has configuration for the domain, its card shows **Clean up**:

- **Cloudflare sending** deletes the zone's sending subdomain and its DNS.
- **Cloudflare receiving** deletes the domain's routing rules and MX, and disables Email Routing on the zone when no other domain uses it.
- **Resend** deletes the domain from Resend and its DNS records. If the domain still receives (or sends) through Resend, only the capability you are leaving is switched off.
- **SES sending** deletes the identity and its DKIM records.
- **SES receiving** deletes the domain's receipt rule and MX.

You cannot clean up the provider that is currently selected.

## Behavior that differs from Cloudflare

- **Routing rules.** Reject and forward rules need to act on the live SMTP session, which only Cloudflare's email handler can do. For mail received through Resend or SES, a reject rule drops the message and forward rules are not applied. Store and categorize rules, mailbox rules, spam handling and webhooks work as usual.
- **Attachments.** Cloudflare sends large files as R2 download links to stay under its 5 MiB limit. Resend and SES send attachments directly, within the administrator's outgoing limit (up to 25 MB).
- **Size.** Inbound mail from any provider is capped at 25 MiB and the same attachment limits apply; larger messages are dropped.

## Microsoft sign-in for connected accounts

Outlook.com, Hotmail and Microsoft 365 accounts cannot sign in to IMAP or SMTP with a password: Microsoft only accepts its own sign-in (OAuth). Kite ships no shared Microsoft app, so the owner registers one for this Kite in Microsoft Entra, once, and enters its IDs and a client secret under **Admin → General → Connected accounts → Microsoft sign-in**. Users then see **Sign in with Microsoft** when they connect an Outlook.com or Microsoft 365 account. This takes about ten minutes and needs no paid Azure subscription: a free Microsoft account can register apps.

Before you start:

- `APP_URL` must be the public HTTPS address of Kite (for example `https://mail.example.com`), because Microsoft sends the browser back to it. Microsoft accepts plain `http` only for `localhost`.
- `APP_ENCRYPTION_KEY` must be set: Kite saves the client secret encrypted and refuses to save it otherwise.
- Open **Admin → General** in Kite and copy the **Redirect URI** shown under **Microsoft sign-in**. It is `APP_URL` followed by `/api/external-accounts/oauth/callback`.

### 1. Register the app

1. Open the Microsoft Entra admin center at <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade> and sign in. (The same page is in the Azure portal at <https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>.)
2. Choose **New registration**.
3. **Name**: anything your users will recognise on Microsoft's consent screen, for example `Kite mail`.
4. **Supported account types**:
   - For Outlook.com and Hotmail **and** work or school accounts: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts**. Use tenant `common` in Kite.
   - For one organisation's Microsoft 365 accounts only: **Accounts in this organizational directory only (Single tenant)**. Use the **Directory (tenant) ID** in Kite.
5. **Redirect URI**: platform **Web**, value the Redirect URI you copied from Kite, exactly (`https://mail.example.com/api/external-accounts/oauth/callback`).
6. Choose **Register**. On the app's **Overview** page, copy the **Application (client) ID** (and, for a single-tenant app, the **Directory (tenant) ID**).

### 2. Add the mail permissions

1. In the app, open **API permissions** and choose **Add a permission**.
2. Choose **Microsoft Graph**, then **Delegated permissions**.
3. Tick `IMAP.AccessAsUser.All` and `SMTP.Send` (search for "IMAP" and "SMTP"), and also `offline_access`, `openid` and `email` under **OpenId permissions**. Choose **Add permissions**.
4. Optional, for a Microsoft 365 organisation where users may not approve apps themselves: choose **Grant admin consent for (your organisation)** and confirm. Without it, a user of such an organisation sees "Need admin approval" at sign-in, and Kite says the same.

Kite asks Microsoft for `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`, `offline_access`, `openid` and `email`; the Graph permissions above are how Entra lists those. Kite never asks for access to files, contacts or calendars.

### 3. Create a client secret

1. In the app, open **Certificates & secrets**, tab **Client secrets**, and choose **New client secret**.
2. Enter a description (for example `Kite`) and an expiry. Microsoft allows at most 24 months; note the date.
3. Choose **Add**, then copy the secret's **Value** at once (Microsoft shows it only now). Do not copy the **Secret ID**.

### 4. Enter it in Kite

1. Open **Admin → General** in Kite (only the primary administrator can change this) and find **Microsoft sign-in** in the **Connected accounts** card.
2. Enter the **Application (client) ID**, the **Tenant** (`common`, or the Directory (tenant) ID for a single-tenant app) and the **Client secret** (the Value).
3. Choose **Save**. Kite checks the ID and secret with Microsoft before saving: a wrong secret, a Secret ID instead of the Value, an unknown client ID or tenant is refused with Microsoft's reason. The secret is saved encrypted and never shown again; **Replace** and **Remove** are next to it.

The registration can also come from the `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` and (optional, default `common`) `MICROSOFT_OAUTH_TENANT` secrets, which win over the saved one, as `RESEND_API_KEY` does.

### 5. Microsoft 365: check IMAP and Authenticated SMTP for each mailbox

Do this for every Microsoft 365 mailbox before its user connects it (Outlook.com and Hotmail accounts need nothing). Microsoft 365 can turn IMAP and authenticated SMTP off per mailbox or for the whole organisation, and SMTP AUTH is off by default in newer tenants. Without IMAP the sign-in ends with "Outlook refused Kite's IMAP sign-in"; without Authenticated SMTP the account connects but cannot send as its address.

1. Open the Exchange admin center at <https://admin.exchange.microsoft.com/#/mailboxes>, choose the user's mailbox, then **Manage email apps** under **Email apps**.
2. Make sure **IMAP** and **Authenticated SMTP** are both on, and choose **Save** if you changed anything.
3. For the whole organisation, open <https://admin.exchange.microsoft.com/#/settings>, **Mail flow**: **Turn off SMTP AUTH protocol for your organization** must be unticked, unless every mailbox that sends through Kite has Authenticated SMTP turned on itself (the per-mailbox setting wins).
4. With Exchange Online PowerShell you can check a mailbox at once: `Get-CASMailbox user@example.com | Format-List ImapEnabled,SmtpClientAuthenticationDisabled` must show `ImapEnabled : True` and `SmtpClientAuthenticationDisabled : False` (or empty, which follows the organisation setting).

Changes can take an hour to reach every server.

### When the client secret expires

Microsoft refuses an expired secret, so Kite cannot renew any connected Microsoft account's access: their checks pause with "Microsoft refused this Kite's app registration" and retry on their own. Create a new secret (step 3) before the old one expires and **Replace** it in Kite; the accounts carry on without anyone reconnecting.

### Which account Kite connects

Kite connects the address the user signed in to Microsoft as: the sign-in name (`preferred_username`, which is the user principal name of a work or school account and the address of a personal one), never a free-form `email` claim an organisation can set, and only after Outlook's IMAP server accepted that address with the new access. The sign-in must come from a tenant that fits the registration (its own tenant for a single-tenant app, personal accounts only for `consumers`, work and school only for `organizations`). Kite records the tenant and Microsoft's user id with the account, and **Reconnect** only accepts the same address signed in as the same user in the same tenant.

### What Kite stores

The refresh token Microsoft issues is stored encrypted with `APP_ENCRYPTION_KEY` in place of a password, and the current access token is cached encrypted until five minutes before it expires; Microsoft hands out a new refresh token with each renewal, and Kite keeps the newest. Neither is ever shown, logged, sent to the browser or kept in a backup. A user who revokes Kite at <https://account.live.com/consent/Manage> (personal accounts) or <https://myapps.microsoft.com> (work or school), changes their password, or does not use the account for 90 days sees **Sign-in failed** with **Reconnect** on the account.

## Configuration reference

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend key used when none is saved in the app |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | SES credentials used when none are saved in the app |
| `APP_URL` | Public HTTPS address; required for Resend and SES receiving, because the providers call this app, and for Microsoft sign-in, whose redirect URI sits under it |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` | Microsoft sign-in for connected accounts, used instead of the registration saved in the app; the tenant defaults to `common` |

Settings saved in the app take precedence over these variables, except Microsoft sign-in, where the variables win. Keys saved in the app are stored as plain text in the `app_settings` table (as the AI provider key already is), so protect database backups accordingly; the Microsoft client secret is the exception and is stored encrypted with `APP_ENCRYPTION_KEY`.
