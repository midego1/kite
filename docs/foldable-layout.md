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

## Posture detection

`resolveBaseFoldPosture` uses the width first, then the Viewport Segments signals:

- width `<= 700px`: **folded**. The phone shell itself still follows Tailwind's `md` breakpoint (`767px`), so a small tablet in the 701–767 range keeps the phone header and menu over a two-pane mail view.
- viewport segments (`(horizontal-viewport-segments: 2)` or `window.viewport.segments` with two entries),
  legacy `(screen-spanning: single-fold-vertical)`, a coarse pointer under `1100px`, or any width under
  `1024px`: **unfolded**.
- everything else (at least `1024px`, a fine pointer and no fold signals): **desktop**.

The hook subscribes to `matchMedia` changes for those queries plus `resize`, `orientationchange`,
`change` on `window.viewport`, storage and the appearance-change event. It is SSR-safe: the server snapshot
is `desktop`, so nothing reads `window` during server rendering; the `<head>` bootstrap script
(`foldPostureBootstrapScript`) sets the real posture before paint. `<html data-fold-posture>` always carries
the effective posture for styling and tests.

`resolveFoldReadingPane` maps the posture to the panes:

- **folded**: `none` (the list, then the message full screen with **Back to Inbox**).
- **unfolded**: `right` (list beside the reader).
- **desktop**: the existing reading-pane preference, exactly as `getEffectiveReadingPaneMode` did before.

`message-split-layout.tsx` reads the hook instead of the old `1024px` media query. The selected message lives
in the URL, so folding or unfolding while a message is open keeps that message and its page state; only the
pane arrangement changes.

### Hinges

When `window.viewport.segments` reports two side-by-side screens, `foldHingeFromSegments` computes the gap,
the outer margins and the first screen's width. The split panel group gets `data-fold-hinge="vertical"` and
`.fold-hinge` (`src/app/globals.css`): the list starts in the first segment, the reader in the second, and the
hinge stays empty. CSS `env(viewport-segment-*)` values are used where the browser supplies them, with the
measured geometry as the fallback.

## The setting

**Settings → Appearance → Foldable screens → Fold layout** is a per-browser preference
(`FOLD_LAYOUT_PREFERENCE` in `src/components/appearance-preferences.ts`):

- **Auto (follow the device)** is the default.
- **Always single pane** forces the folded posture (and `data-fold-posture="folded"`).
- **Always two panes** forces the unfolded posture (and `data-fold-posture="unfolded"`).

The phone shell itself still follows the viewport width, so forcing two panes on a real phone keeps the
mobile sidebar and header, while the mail list and reader become two panes.

## Demo

1. In browser devtools start at 390×844 (folded): the Inbox is a single list; opening a mail replaces it and
   **Back to Inbox** returns.
2. Resize to 884×1104 (unfolded): the list and the reader appear side by side. Open a message and resize back
   and forth; the same message stays open.
3. Resize to 1440×900: desktop looks and behaves as before, including the account's reading-pane preference.
4. On any viewport open **Settings → Appearance → Fold layout** and choose **Always two panes** or **Always
   single pane** to force the posture regardless of width; `<html data-fold-posture>` and `data-fold-layout`
   show the result.
