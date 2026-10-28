### Fixed

- Reloading right after a new version of Kite is deployed, from the "Kite was updated" notice or by hand, no longer sometimes leaves the page on "Loading" until a second refresh. When the page names app files that do not load (for example while a deploy is still reaching every location), Kite now reloads by itself, a few times with a growing wait. A tab that is already open and cannot load part of the previous version checks for the update at once and shows the notice instead of failing silently.
