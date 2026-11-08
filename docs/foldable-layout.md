# Foldable layout

Kite treats a foldable device as three postures: **folded** (the narrow cover screen, one pane like a phone),
**unfolded** (the wide inner screen or a tablet, list and reader side by side) and **desktop** (the existing
desktop layout). The rules live in `src/components/fold-posture-utils.ts` (pure and unit tested) and
`src/components/use-fold-posture.ts` (the live hook).

## Audit of the layout before this change

| Area | Decision before | Where |
| --- | --- | --- |
| Phone shell | `useIsMobile()` matches `(max-width: 767px)`; the sidebar is a sheet and the dashboard shows its phone header | `src/components/sidebar-mobile-utils.ts`, `src/components/sidebar-frame.tsx`, `src/components/sidebar-aside.tsx` |
| Desktop shell | Tailwind `md` (768 px) and up: resizable sidebar and page panels | `src/components/sidebar-panels.tsx`, `src/app/(dashboard)/dashboard-shell.tsx` |
| Message list / reader | `useWideReadingViewport()` matches `(min-width: 1024px)`. Below `lg` the effective reading pane is always `none`; above it the account's `none`/`right`/`below` choice applies | `src/components/messages/reading-layout-utils.ts`, `src/components/messages/use-reading-layout.ts`, `src/components/messages/message-split-layout.tsx` |
| Reading pane preference | Saved per browser and (when layout sync is on) per account from the account menu or Settings | `src/components/messages/use-reading-layout.ts`, `src/components/layout-preferences-client.ts` |
| Sidebar rail | Collapsed state is a width preference, forced to the rail on phones | `src/components/sidebar-state.tsx` |
| Assistant | Docked at the right and resizable, or a floating window; width clamped to leave room for the list | `src/app/(dashboard)/dashboard-shell.tsx` |
| Composer | Fixed/floating composer follows the viewport with its own `1024px` media rules | `src/components/compose/`, `src/app/globals.css` |
| Other responsive CSS | `767px` for phone toasts and `1023px`/`1024px` for the docked composer's toast placement | `src/app/globals.css` |

There was no handling for the CSS Viewport Segments API, `screen-spanning`, hinges, or a live fold/unfold
change.

## Right to left

In a right-to-left interface (the Direction setting in the account menu) the split mirrors with the rest of the app: the list sits on the second screen and the reader on the first, so reading still starts on the side the sidebar is on. The hinge logic is unchanged: the list may not cross it (`foldHingeListWidth`) and, with the list hidden, the reader keeps to its own screen (`foldHingeStyle`). Viewport Segments stay physical, so the padding does too; the panel group is physically reversed (`src/components/ui/resizable.tsx`). The posture itself does not depend on the direction. `e2e/99-rtl-interface.spec.ts` covers it.

## Posture detection

`resolveBaseFoldPosture` uses the width first, then the signals a foldable or a tablet gives:

- width `<= 700px`: **folded**. The phone shell itself still follows Tailwind's `md` breakpoint (`767px`), so a small tablet in the 701–767 range keeps the phone header and menu over a two-pane mail view.
- viewport segments (`(horizontal-viewport-segments: 2)` or `window.viewport.segments` with two entries) or
  the legacy `(screen-spanning: single-fold-vertical)` query: **unfolded** at any width.
- a touch screen (`(pointer: coarse)`) at most `500px` high with no segments: **folded**. That is a phone held
  sideways (for example 844×390), which has no room for two panes.
- any other touch screen under `1100px`: **unfolded** (a tablet).
- everything else: **desktop**. A narrow window with a mouse, say 900 px wide, is still a desktop and shows one
  pane, as it always did.

The hook reads the browser only when one of those thresholds flips (each is a `matchMedia` query) or on
`orientationchange`, `change` on `window.viewport`, storage and the appearance-change event, so dragging a
window edge does not re-render the page for every pixel. It is SSR-safe: the server snapshot is `desktop`, so
nothing reads `window` during server rendering; the `<head>` bootstrap script (`foldPostureBootstrapScript`)
sets the real posture before paint, and a unit test checks that it agrees with `resolveBaseFoldPosture`.
`<html data-fold-posture>` always carries the effective posture for styling and tests; `FoldPostureSync`
(mounted in `Providers`) keeps it up to date.

`resolveFoldReadingPane` maps the posture to the panes:

- **folded**: `none` (the list, then the message full screen with **Back to Inbox**).
- **unfolded**: the reading-pane choice as saved (**No split** and **Below inbox** still apply). Only
  **Always two panes** turns a saved **No split** into a side-by-side split.
- **desktop**: the reading-pane choice from 1024 px up, one pane below that, as before.

Two panes also need room: the list at least 250 px, the reader at least 280 px and the handle. `useFoldSplit`
measures the width the panes would have (next to the sidebar and a docked assistant) and falls back to one pane
when it is under that minimum, whatever the posture or setting says. **Always two panes** on a 390 px cover
screen therefore still shows one pane.

`message-split-layout.tsx` reads the hook instead of the old `1024px` media query. The selected message lives in
the URL, so folding or unfolding while a message is open keeps that message open. The panes are rebuilt when the
arrangement changes, so the list and reader scroll positions and an expanded conversation start over.

The list can be hidden and shown again from the message header at any width; **Back to Inbox** replaces that
button only in the single-pane layout.

### Hinges

When `window.viewport.segments` reports two side-by-side screens, `foldHingeFromSegments` computes the gap,
the outer margins and the first screen's width. The split panel group gets `data-fold-hinge="vertical"` and
`.fold-hinge` (`src/app/globals.css`): the list fills what is left of the first screen (the sidebar takes the
rest of its left edge), the reader starts on the second screen, and the hinge stays empty. The list's resize
handle is off beside a hinge, so the width saved for other devices is not overwritten. With the list hidden the
reader still starts on the second screen. CSS `env(viewport-segment-*)` values are used where the browser
supplies them, with the measured geometry as the fallback.

## The setting

**Settings → Appearance → Foldable screens → Fold layout** is a per-browser preference
(`FOLD_LAYOUT_PREFERENCE` in `src/components/appearance-preferences.ts`):

- **Auto (follow the device)** is the default.
- **Always single pane** forces the folded posture (and `data-fold-posture="folded"`).
- **Always two panes** forces the unfolded posture (and `data-fold-posture="unfolded"`).

The phone shell itself still follows the viewport width, so forcing two panes on a phone-sized window keeps the
mobile sidebar and header, while the mail list and reader become two panes, as long as they fit.

## Settings and Admin on a touch screen

The Settings and Admin menu (`src/components/settings/section-nav.tsx`) follows Tailwind's `md` breakpoint for its
own rows (`max-md:min-h-11`), which misses an unfolded foldable or a tablet at or above 768 px: still a touch screen,
with no hover, but wide enough to show the inline menu column instead of the phone sheet. Those rows, and a few other
small touch targets this area shares with sign-in (the Settings/Admin "Back to inbox" and "Need a hand?" buttons, a
mailbox rule's hover-revealed delete button, a domain's actions menu, the connected account two-way sync disclosure,
and the sign-in/setup primary buttons and secondary links), also check `(pointer: coarse)` directly
(`[@media(pointer:coarse)]:min-h-11`, matching the `[@media(hover:none)]:opacity-100` already used for the agent
panel's hover-revealed actions), so they reach a full 44 px touch target and stay visible without a hover state
whatever the width. Test at 884×1104 with touch emulation on to see the difference from a mouse window of the same
width.

## Demo

1. In browser devtools start at 390×844 (folded): the Inbox is a single list; opening a mail replaces it and
   **Back to Inbox** returns.
2. Turn on touch emulation in devtools (a tablet or unfolded foldable has a touch screen) and resize to
   884×1104 (unfolded): the list and the reader appear side by side. Open a message and resize back
   and forth; the same message stays open.
3. Resize to 1440×900: desktop looks and behaves as before, including the account's reading-pane preference.
4. On any viewport open **Settings → Appearance → Fold layout** and choose **Always two panes** or **Always
   single pane** to force the posture regardless of width; `<html data-fold-posture>` and `data-fold-layout`
   show the result.

## Touch reachability

A coarse pointer (a finger) never hovers, so nothing a mouse user reaches by hovering may be the only way to
reach it on a touch screen — including an unfolded foldable or a tablet at `md` and up, which gets the desktop
sidebar (a pure width breakpoint, `src/components/sidebar-mobile-utils.ts`) but is still a touch screen. The
Tailwind `pointer-coarse:` variant (`@media (pointer: coarse)`) is how the app tells the two apart:

- **Message list row actions** (star, archive, trash, mark read/unread, snooze, move) float over a row on hover
  for a mouse (`message-list-row-actions.tsx`, unchanged, `pointer-fine:` only). An always-on action bar under
  every row was tried and reverted: on a touch screen it doubled a stacked row's height (halving the list's
  density for no reason — a swipe already marks read/unread and archives, `swipeable-row.tsx`) and, being
  appended after the row's own content, pushed the corner star's `bottom-0` anchor down to collide with it. A
  coarse pointer gets a single always-visible, 44px **⋯** button instead (`row-actions-menu.tsx`), beside the
  corner star rather than above or below it — the row is rarely tall enough for two stacked 44px corners not to
  overlap — opening a bottom sheet that lists every action as a full-width, 44px item, with Snooze and Move to
  expanding in place for their own sub-choices (after `snooze-picker.tsx`'s `SnoozeMenuItem`). The row's text
  reserves this corner's width on every line it has (not just the one a floating pill used to sit over), so nothing
  needs to hide under it — the previous design's `pointer-coarse:opacity-0` on a wide row's date was that same
  overlap bug from the other side: an overlay with no reserved space of its own.
- **The reader toolbar** (Reply, Archive, Snooze, Move, Report spam, Mark read, More, Delete) wraps onto a second
  line instead of overflowing the sticky header and pushing **More actions** off screen on a narrow phone or a
  pinched reading pane (`message-actions.tsx`; ported from the upstream Mailflare review, item 14): the header
  is `min-h-14`, not a fixed height, so it grows to fit (`src/app/(dashboard)/inbox/[messageId]/page.tsx`).
  Not `overflow-x-auto` — that makes the row a clipping boundary Radix's Popper measures itself against, which
  moves the Move-to and Snooze menus to the wrong place the moment the row has less room than its content needs.
  Its buttons, and small icon buttons generally across the sidebar, the list header and the filter chips, grow
  to at least 44px on a coarse pointer (`pointer-coarse:h-11`/`w-11`, or the `.reader-toolbar` rule in
  `globals.css` for the `roundedSM` button size, which a higher-specificity rule there already sizes).
- **New mail** is a floating button on phone and foldable screens (`mobile-compose-fab.tsx`), beside the tab
  bar's own show/hide rules (`mobile-tab-bar-utils.ts`): it steps aside for an open message (whose own reply bar
  would collide with it) even where the tab bar itself stays, with the list beside the reader. A folder list
  adds its own bottom padding below `md` (`max-md:pb-20` in `message-folder-page.tsx`) so the button floats
  clear of the last row's own star and ⋯ instead of covering them.
- `viewport-fit: cover` (`src/app/layout.tsx`) is what makes `env(safe-area-inset-*)` — already used by the tab
  bar, the compose button and the Drive upload panel — resolve to a real value instead of `0px`; paired with
  `appleWebApp: { capable: true }`, a phone can run the page from its home screen without browser chrome today,
  ahead of a full installable PWA (a manifest and a service worker are unplanned, see `ROADMAP.md`). It is a
  page-wide meta tag, so it also makes a left or right inset real (a landscape phone's notch, a device's rounded
  corners) wherever Kite had none before: the dashboard shell's own root pads for `safe-area-inset-left`/`-right`
  (`dashboard-shell.tsx`, `dashboard-section-shell.tsx`), physical by nature like the insets at the bottom
  (`tests/logical-css.test.mjs`'s `ALLOWED` list).
