### Added

- [Admin → Storage](/storage) can now delete the old copies cold storage moves left behind: use **Delete leftovers** on a store, or on every store from the new Leftover copies section. A copy is only deleted after a grace period, once Kite has confirmed the object is still readable elsewhere or no longer used, and never while a backup you keep could still need it. Deleting a store that only holds leftovers now offers this too. This needs a database update applied from the Admin overview.
  ![Delete leftovers on a store and the Leftover copies section in Admin → Storage](/changelog/2026-11-10-delete-leftovers-light.webp)
- The cleanup can also run on its own every few minutes; it is off until you turn on **Delete leftovers automatically** there, where you can also change the grace period.
