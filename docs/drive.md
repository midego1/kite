# Drive

Drive keeps files and folders next to your mail. Open it from the **Drive** item in the sidebar or the mailbox menu, or with **Open Drive** in the command palette. The sidebar stays the mail menu; the Drive views (My Drive, Recent, Shared with me, All attachments, Trash) are a menu beside the list, with the storage you have used at its foot. It is a module: the owner can turn it off for everyone or for some users (see [Modules](modules.md)).

Apply database migration 0064 after deploying the release that adds Drive, from the database card on the admin overview. Until then Drive shows that the update is pending, lists nothing and refuses changes.

## Views

| View | What it shows |
| --- | --- |
| **My Drive** (`/drive`) | Your own files and folders. A folder opens at `/drive/f/<id>` with its path above the list. |
| **Recent** | Your own files from every folder, most recently changed first. |
| **Shared with me** | Files and folders other people shared with you. |
| **All attachments** | The attachments of the mail you can read, with their sender. **Open email** opens the message, **Save to Drive** copies the file into a folder. Nothing is copied until you save it. |
| **Trash** | What you moved to the trash. |

Search finds names, and the type chips (Photos, Videos, Documents, Others) narrow the list. Click a file to preview it: images, video, audio, PDF and plain text open in the page; other files offer a download. Each row's **⋮** menu has the actions you are allowed to take, and selecting rows gives the same actions for many items at once (up to 100).

## Uploading

Use **Upload files** or **Upload folder** above the list, or drop files on the list. Folders keep their structure. Files are sent in parts of 32 MiB through Kite, or of 64 MiB straight to the storage provider when an admin has set that up under Admin → Storage, and the **Uploads** panel shows each one's progress. If an upload is interrupted, uploading the same file into the same folder again within three days continues where it stopped; after that the unfinished upload is removed. One account can have 20 uploads in progress at a time.

**Save to Drive** in an attachment's menu, in the reader or under All attachments, copies the attachment into the folder you choose. The copy is independent of the message: deleting the mail keeps the file. A flagged attachment (a program, a macro document, an archive, …; see [Risky attachments](spam-protection.md#risky-attachments)) shows its warning first, and the copy waits until you tick **I understand the risk**. The same goes for downloading one under All attachments: it opens the preview with the warning, and a bulk download skips it.

## Folders, moving and the trash

**New folder** above the list creates a folder; folders nest up to 64 levels. **Rename**, **Move** and **Move to trash** are in each row's menu. A folder in the trash takes everything inside it along, and **Restore** brings it all back. In the trash, **Delete forever** removes an item and its contents at once, after you confirm. Items left in the trash are deleted for good after the retention the admin sets (30 days by default), by a job that runs daily at 02:00 UTC.

## Sharing with people

**Share** opens the share dialog. Under **People with access**, enter the address of someone on this install who has Drive and choose:

- **Can view**: they can open, preview and download it.
- **Can edit**: they can also rename, move and trash items, upload into a shared folder and create folders in it. Files they add count against the owner's storage.

A share on a folder covers everything inside it. Only the owner gives or removes edit access; an editor can share with view. The people you share with find the item under **Shared with me**. Removing someone ends their access at once. Only the owner deletes forever, restores from the trash or creates public links.

## Public links

The owner can create public links in the share dialog under **Public links**. Anyone with the link can open it at `/d/<token>` without signing in:

- A file link shows a preview and a **Download** button. A folder link lists the folder (folders first) and lets the visitor open the folders inside it, but nothing outside it.
- Every link expires. You choose after how many days, up to the limit the admin sets (30 days by default, never more than 365).
- A link can have a password. The visitor enters it once per browser; it then stays open there for an hour. Wrong passwords are rate limited.
- **Revoke** ends a link at once. A revoked or unknown link answers "not found", and an expired one says that it has expired.
- The dialog shows when each link was last opened and how often its file was fetched (a preview and a download each count).
- The page shows the install's name and icon, never the owner's name or address, and asks search engines not to index it.

The full link is shown when you create it. Afterwards the dialog shows it again only when `APP_ENCRYPTION_KEY` is set, because the database otherwise keeps just a hash of it. Links stop working when the owner's account is disabled or Drive is off for the owner, and come back when it is on again.

## Money Watch's receipts

When [Money Watch](specs/money-watch.md)'s **Keep receipts** setting is on (the default), tracking a subscription, recording its documents or recording a payment found in mail files a copy into your own Drive under `Money Watch/Receipts/<year>/`: the mail as `.eml`, a self-contained sanitized HTML copy with no remote content or scripts, a PDF (the HTML and the PDF are always attempted together, never one without the other), and the receipt attachment itself. These are ordinary files you own: they count toward your Drive storage, show up in **My Drive** and **Recent**, and can be moved, renamed, shared or trashed like anything else. Filing happens shortly after the row is recorded, by a background task that runs every few minutes, so keep the mail until the copy shows up in Drive. A row from a mailbox set to No AI is never filed, and the receipt attachment is copied separately only when the row names one and it passes the same risk check as any attachment; a flagged attachment is not copied on its own and stays inside the `.eml`. Money Watch never deletes them, including when the tracked row itself is removed; its own delete confirmation says so first. Turning Money Watch's Keep receipts setting off, or turning Drive off, stops new copies from being made but never removes the ones already there (a filing already in flight may still finish).

The `Money Watch`, `Receipts` and year folders themselves are the one exception worth knowing about: filing always looks for a folder with exactly that name in exactly that place, so if you move, rename or trash one of them, the *next* receipt either restores it (if you trashed it directly) or creates a fresh one with the right name back where it belongs (if you moved or renamed it, or trashed something it was moved into) — your move or rename is kept, but future receipts stop following it there. A folder you trashed and that a later receipt restores comes back with everything that was already inside it. Only a folder Money Watch created itself is restored this way: a trashed folder you made yourself with the same name stays in Trash, and a fresh one is created.

## Linked folders (WebDAV)

A folder on a WebDAV server (Nextcloud, ownCloud and most NAS devices) can be linked into your Drive. It shows under **Linked folders** in the Drive menu and opens at `/drive/m/<id>`; only you see it, and the files stay on that server: Kite passes every listing and transfer through and copies nothing into its own storage or database.

- **Linking.** **Link a folder** asks for the folder's WebDAV address (for Nextcloud, under Files → Files settings → WebDAV, for example `https://cloud.example.com/remote.php/dav/files/you/` or a folder below it), your username and an app password. Create an app password for Kite in the server's security settings instead of using your own password. Kite asks the server for the folder (a WebDAV `PROPFIND`) before saving, so a wrong address, username or password is refused in the dialog. The password is saved encrypted with `APP_ENCRYPTION_KEY` and is never shown, returned or logged again; without that key the dialog says linking is unavailable. **Edit link** in the folder's **⋮** menu changes the name, address, username or password. Leave the password empty to keep it, as long as the address and username stay the same: the saved password is only ever sent to the address and username it was saved with, so changing either asks for it again. Each account can check up to 20 links or edits a minute.
- **Working in it.** Open folders and files (previews as in My Drive, downloads with resume), **Upload files** or drop files on the list, **New folder**, and per row **Rename**, **Move** (to another folder in the same linked folder) and **Delete**. Uploads go through Kite up to 100 MB per file, at most 20 at a time per account. Nothing is ever overwritten: an upload, rename or move onto an existing name is refused. **Delete** removes the item on the server at once, after you confirm; linked folders have no Kite trash. **Unlink folder** only removes the link: nothing on the server is deleted.
- **Save to Drive** can save an attachment into a linked folder: choose it under **Save in**, then the folder. The same risk warning applies.
- **When the password stops working** (revoked on the server, or after a restore from backup), the folder shows a red mark in the Drive menu and a banner with **Update app password**.
- **Not in this version.** Linked items cannot be shared with people or by public link, they do not appear in Recent, search or All attachments, and they do not count toward your Drive storage. Files larger than 100 MB cannot be uploaded yet (Nextcloud's chunked upload is not built). Google Drive and OneDrive are planned.

**Which addresses work.** Only public `https` addresses can be linked. Private and local addresses (a NAS on your home network, `localhost`) are refused, and so is plain `http`, also when a server redirects there; Kite never sends the password to another host after a redirect. On Cloudflare a NAS therefore needs a public `https` address. On the Node and Docker server, `STORAGE_ALLOW_PRIVATE_ENDPOINTS=1` (the same switch as for a MinIO store) lets you link a server on the local network, over `http` or `https`; see [Self-hosting](self-hosting.md). Each request has 20 seconds to get an answer (an upload also gets time for its size), a download that sends nothing for a minute or runs over an hour is cut off (also when the browser stopped reading it), a server that compresses part of a file despite being asked not to gets an error instead of the wrong bytes, a folder listing may be at most 4 MiB with 5,000 items, and the server's XML is read without document type declarations or entities.

Apply database migration 0107 after deploying the release that adds linked folders. Until then the **Linked folders** section stays hidden and its API answers that the update is pending. Database backups include linked folders without their app passwords (the `drive` group); after a restore each one asks for its password again.

## Storage

The sidebar shows how much you use, and with a limit, a bar and "used of limit". An upload that does not fit is refused with "Not enough Drive storage left for this file". Files in the trash and uploads in progress count until they are deleted.

## Admin → Drive

Admins find **Drive** in the Admin menu under System (`/drive/settings`):

- **Storage per account (GB)**, empty for no limit.
- **Allow public links** and **Longest link lifetime (days)**, 1 to 365. Turning links off ends every existing link (they work again when links are turned back on, until they expire) and replaces the share dialog's link form with "An admin has turned public links off".
- **Keep trashed items for (days)**, 1 to 365.
- **Usage**: each account's storage, with a storage override per account that beats the default.

Changes are written to the audit log.

## Turning Drive off

The owner turns Drive off under **Admin → Modules**, or for one user under **Accounts → (user) → Permissions → Modules**. While it is off for someone, the sidebar item, the palette command and **Save to Drive** disappear for them, Drive pages show "Page not found", the API answers 404 and that user's public links answer 404 too. Nothing is deleted: turning it on again brings back every file, share and link.

## Where files live

File contents are stored in the install's object storage under `drive/<id>` (the `BUCKET` R2 bucket on Cloudflare, the `blobs` folder of the data directory on Node and Docker), or in an S3-compatible store an admin chose for Drive under Admin → Storage. With such a store, downloads of 8 MiB or more open a five-minute signed link to the store; public links always go through Kite. Names, folders, shares and links are in the database. Database backups include that metadata but not the file contents, as with mail attachments; see [Privacy](privacy.md#what-is-stored-where) and [Operations](operations.md#drive-files).
