# Mailing lists and unsubscribing

When you open a message that came from a mailing list or newsletter, Kite shows a small notice above it: "This message is from the mailing list Weekly News." (or "from a mailing list." when the list names itself only by an address), with an **Unsubscribe** button and a button to hide the notice. The feature is ported from upstream Mailflare #279; the one-click part is Kite's own.

## When the notice appears

A message counts as list mail when it carries a `List-Id` header (RFC 2919) or a `List-Unsubscribe` header (RFC 2369) with an `https`, `http` or `mailto:` link. The notice shows only on mail you received, and never on:

- mail in **Spam**: unsubscribing from spam tells the sender your address is read, so report it instead;
- mail in **Trash**;
- mail the [Screener](screener.md) is still holding.

The list name comes from the `List-Id` header. Kite decodes it, removes control and direction-changing characters and keeps at most 80 characters, so a sender cannot use it to disguise the sentence around it. A name in a right-to-left script stays in one piece in either interface direction.

## Unsubscribe

What **Unsubscribe** does depends on what the sender offers:

- **One-click unsubscribe (RFC 8058).** When the message asks for it (exactly one `List-Unsubscribe-Post: List-Unsubscribe=One-Click` field and exactly one `List-Unsubscribe` field with an `https` link), every DKIM signature in it covers both headers, and a signature passed when the mail arrived, Kite asks "Unsubscribe from this list?" and then sends the sender's server the standard one-click request itself. You do not open any page; the notice then says "You're unsubscribed. The sender may take a few days to stop." If the sender's server does not confirm, the notice says Kite couldn't unsubscribe you automatically and offers **Open the unsubscribe page**.
- **A link.** Otherwise Kite opens the sender's unsubscribe page in a new tab, or hands a `mailto:` link to your mail program, exactly as **Unsubscribe** in the message's **⋯** menu always has.

The **⋯** menu's **Unsubscribe** uses the same one-click request when the message offers it. Only people with full access to the mailbox can have Kite unsubscribe; someone the mailbox is shared with read-only sees the notice, and **Unsubscribe** opens the link for them.

Kite only ever sends the one-click request to the address in the message's own signed header, never to one a browser supplies. Kite records that a DKIM signature passed but not which one, so a message with any signature that does not cover the list headers, or with a second `List-Unsubscribe` field (which a signature would not cover), gets the link instead. The request goes to public `https` addresses only, through the same guard as webhooks: no private, local or cloud-metadata addresses, no credentials in the link and, on a self-hosted server, every address the name resolves to must be public. It never follows a redirect, carries no cookies, gives up after 10 seconds (the name lookup included), and only a 2xx answer counts as done. Nothing the sender answers is shown or stored; the server log records only the link's host and the outcome (`unsubscribe.one_click`, `unsubscribe.one_click_failed`). The requests count against the same per-user rate limit as the remote image proxy, under a key of their own (see [Operations](operations.md#one-click-unsubscribe)).

## Hiding the notice

The **×** button hides the notice for that list (by its `List-Id`), or for that sender when the message names no list, in this browser. A toast offers **Undo**. The choice is kept in the browser's local storage (`kite-mailing-list-notice-dismissed`, the 500 most recent lists), not on the server, and is cleared when you sign out. Hiding the notice never unsubscribes you, and **Unsubscribe** stays in the **⋯** menu.

## Accessibility

The notice is a labelled region ("Mailing list") that every button in it can reach by keyboard. Its result ("You're unsubscribed", or the failure) is announced politely. After you hide it, focus moves to the message instead of being lost.
