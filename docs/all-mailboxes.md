# All mailboxes

If you can open more than one mailbox (your own addresses, and shared mailboxes someone gave you access to), **All mailboxes** shows their mail in one Inbox, Starred, Snoozed, Sent, Drafts, Archive, Spam and Trash. A single mailbox stays one click away.

## Turning it on

Open the mailbox selector at the top of the sidebar and choose **All mailboxes**, the first entry. It is offered once you can open two or more mailboxes. Choosing a single mailbox in the same menu (or in the account menu) leaves the combined view. The command palette (Cmd+K) has **Show all mailboxes** and **Show one mailbox** too.

Your browser remembers the choice. Nothing is stored on the server, so another browser or device starts with one mailbox.

## What you see

- **Every mailbox you can open**, and only those: your own mailboxes and the shared ones you were given access to. Being an administrator does not add anyone else's mailbox; the view holds exactly the mailboxes you could open one by one.
- **A label on each email** with the name of the mailbox it belongs to, in that mailbox's colour.
- **Counts added up.** The numbers next to Inbox, Starred and the other folders are the totals of the mailboxes in view.
- **Folders per mailbox.** Your own folders are listed under the name of the mailbox they belong to. New folders still belong to one mailbox: **Create folder** asks which one.
- **Conversations per mailbox.** In conversation view a thread is grouped within one mailbox. When the same email reached two of your mailboxes, each mailbox shows its own conversation.
- **The Screener** is listed while any mailbox in view holds new senders back, and shows their held mail together.

## Choosing which mailboxes to show

While **All mailboxes** is on, the mailbox selector shows a **Show** list with a checkbox per mailbox. Uncheck a mailbox to leave it out of the combined view; its mail, counts and folders disappear until you check it again. The last mailbox cannot be unchecked. Your browser remembers the choice, and a mailbox you get access to later is shown by default.

## Reading and answering

- **Reply, reply all and forward** go out from the mailbox the email arrived in, whichever mailbox you were in before.
- **A new email** (Compose) asks for the From address and starts from the one you used last.
- **Search, the keyboard shortcuts** (`j`/`k`, `e`, `#`, `x`, and `r`/`a`/`f` in an open email) and the command palette work as in a single mailbox.
- **Bulk actions** (mark read, archive, spam, delete, move) work on a selection across mailboxes, and each email stays within its own mailbox. **Move to** a folder lists folders when the selection is from one mailbox; with mail from several, it says to select mail from one mailbox.

## Shared mailboxes with read-only access

Mail in a mailbox shared with you as read-only can be read and marked read or unread, never archived, moved or deleted, in the combined view as anywhere else. Its rows have no archive or delete buttons, the reader's buttons for those are off, and `e` or `#` say that read-only mail can't be moved or deleted. When a bulk action includes read-only mail, the rest is done and a notice says how many read-only emails were left as they were. The server checks this on every request.

## Everything else stays per mailbox

Live updates, notifications, the For you page, automatic reading suggestions, rules, signatures, auto-replies and Settings work per mailbox, as before. Settings pages use the mailbox you chose last.
