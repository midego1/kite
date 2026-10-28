### Changed

- Uploaded `.eml` and `.mbox` files now keep the state their messages carry in their headers: the mbox `Status` and `X-Status` headers and Gmail Takeout's `X-Gmail-Labels` (`Unread` means unread, `Opened` or Gmail's own labels without it mean read, `Starred` stars) set read and starred, and mail labelled Spam or Trash, or, without Gmail labels, marked `X-Spam-Flag: YES`, is filed in Spam or Trash instead of the Inbox. Only an upload to Inbox is refiled; any other destination you pick is kept. Mail that says nothing arrives unread, as before.
