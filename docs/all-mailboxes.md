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
- **Search, the keyboard shortcuts** (`j`/`k`, `e`, `#`, `x`, Shift+↑/↓, Shift-click and Cmd/Ctrl-click on rows, and `r`/`a`/`f` in an open email) and the command palette work as in a single mailbox.
- **Bulk actions** (mark read, archive, spam, delete, move) work on a selection across mailboxes, and each email stays within its own mailbox. **Move to** a folder lists folders when the selection is from one mailbox; with mail from several, it says to select mail from one mailbox.

## Drafts in shared mailboxes

Drafts are private to the person who wrote them, in a shared mailbox too. Drafts shows only your own drafts, and the Drafts count, search, the conversation view, mailbox export, the REST API and JMAP leave out everyone else's, whatever your access to the mailbox, and also when you own the mailbox or are an administrator. Opening another person's draft or one of its attachments by its link answers "not found". Once a draft is sent, the message is in Sent for everyone who can read the mailbox.

- **A draft leaves Drafts only by being sent or deleted.** **Delete** in Drafts (and `#`) removes the selected drafts at once, with their attachments, after asking: they never go to Trash, where everyone with access to the mailbox would see them, so there is no Undo. Anywhere else a draft can be listed (Starred, search results, All mailboxes), **Delete** on a selection that holds drafts asks first ("Delete a draft permanently?"), deletes the drafts and moves the rest to Trash; a notice says how many drafts were deleted permanently, and Undo brings back only the rest. You can always delete your own drafts, also with only Send as or Send on behalf access to the mailbox. Drafts has no Archive, Report spam or Move to, and the server refuses to move a draft to Archive, Spam, Inbox or a folder (the bulk API answers 409 `DRAFT_MOVE_REFUSED`; JMAP answers `invalidProperties`), or to train the spam filter with it.
- **Nothing is moved into Drafts.** No one, whatever their access, can turn a message of the mailbox into a draft, which would hide it from everyone else: the status API does not take `draft`, an Undo cannot restore a message into Drafts, and JMAP refuses a move into a `drafts` mailbox. New drafts come only from the composer, the assistant, JMAP `Email/set` create and `Email/import`, and mail import.
- **Scheduled sends are shared.** A message you scheduled is no longer a draft: until it goes out it is queued, and everyone who can read the mailbox sees it in Sent, like the sent message it becomes. Cancelling the send puts it back in your Drafts, private again.
- **Removing someone's access deletes their drafts there.** When an administrator removes a member from a shared mailbox, that member's drafts in it are deleted with their attachments, since nobody else could ever open or send them; the confirmation says so ("Their drafts in this mailbox will be deleted. This can't be undone."). Lowering their access (for example to read-only) keeps their drafts.
- **Imported drafts belong to whoever imports them.** Mail imported into Drafts (from an IMAP account or an uploaded file) is the importing user's drafts, private to them like any other.

## Shared mailboxes with read-only access

Mail in a mailbox shared with you as read-only can be read and marked read or unread, never archived, moved or deleted, in the combined view as anywhere else. Its rows have no archive or delete buttons, the reader's buttons for those are off, and `e` or `#` say that read-only mail can't be moved or deleted. When a bulk action includes read-only mail, the rest is done and a notice says how many read-only emails were left as they were. The server checks this on every request.

## Everything else stays per mailbox

Live updates, notifications, the For you page, automatic reading suggestions, rules, signatures, auto-replies and Settings work per mailbox, as before. Settings pages use the mailbox you chose last.
