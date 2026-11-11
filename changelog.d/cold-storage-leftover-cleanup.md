### Added

- **Delete leftovers** in [Admin → Storage](/storage) removes old copies cold storage moves left behind, per store or for all, also when deleting a store. A copy goes only after a grace period, once it is readable elsewhere or unused and no kept backup needs it. Needs a database update applied from the [Admin overview](/admin).
  ![Delete leftovers on a store and the Leftover copies section in Admin → Storage](/changelog/2026-11-10-delete-leftovers-light.webp)
- The cleanup can also run on its own; it stays off until you turn on **Delete leftovers automatically** there, next to the grace period.
