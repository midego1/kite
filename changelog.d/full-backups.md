### Added

- **Include mail files** under [Admin → Backups](/backups): every backup can also copy the raw mail, attachments and large message bodies to its own dated folder in backup storage, with a manifest. The page shows about how many files and how much space that takes before you turn it on, each full backup shows what it copied, and **Restore mail files** puts back the files that are missing without touching the ones that exist. Off by default. Deleting a backup, by hand or by retention, deletes its copies too. Needs migration **0081**, applied from the [admin overview](/admin).

### Changed

- New installs back up daily and keep the last 14 days of backups. Existing installs keep their settings. **Delete old backups automatically** now stays visible on the Backups page while automatic backups are off, because it also removes manual and safety backups.
