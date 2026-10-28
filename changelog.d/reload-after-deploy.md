### Fixed

- Reloading right after a new version of Kite is deployed, from the "Kite was updated" notice or by hand, no longer sometimes leaves the page on "Loading" until a second refresh. For a few seconds after a deploy the page can come from the new version while its files still come from the previous one; Kite now notices the missing files and reloads by itself, a few times with a growing wait. A tab that is already open and cannot load part of the old version shows the update notice instead of failing silently.
