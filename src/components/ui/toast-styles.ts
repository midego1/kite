import type { ToasterProps } from "react-hot-toast";

/**
 * Every transient notice (react-hot-toast, the send and undo-send bars, the composer's result toast) sits in the
 * bottom-right corner, lifted above the reader's reply box and the floating assistant button. `--kite-toast-bottom`,
 * `--kite-toast-top` and `--kite-toast-inset` are set in globals.css (phones get a smaller inset and the safe area),
 * and move while a composer is open (`useComposerZone`): beside the docked composer, below the expanded one, at the
 * top of a narrow screen, so a notice never covers the composer's footer or controls.
 */
export const TOAST_CORNER_CLASS =
	"fixed bottom-[var(--kite-toast-bottom)] top-[var(--kite-toast-top)] right-[var(--kite-toast-inset)]";

/** The card every toast wears. The palette classes are remapped by each look and in dark mode, so it follows the theme. */
export const TOAST_SURFACE_CLASS =
	"rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-900 shadow-lg";

/** The action inside a toast (Reload, Undo): the primary button, which stays legible in light and dark. */
export const TOAST_ACTION_CLASS =
	"shrink-0 rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

/** react-hot-toast styles toasts inline (white card, #363636 text), so the theme variables are applied here instead. */
export function toasterProps(atTop: boolean): ToasterProps {
	return { ...TOASTER_PROPS, position: atTop ? "top-right" : "bottom-right" };
}

const TOASTER_PROPS: ToasterProps = {
	position: "bottom-right",
	containerStyle: {
		top: "var(--kite-toast-top)",
		bottom: "var(--kite-toast-bottom)",
		left: "var(--kite-toast-inset)",
		right: "var(--kite-toast-inset)",
	},
	toastOptions: {
		style: {
			background: "var(--card)",
			color: "var(--foreground)",
			border: "1px solid var(--border)",
			boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
			maxWidth: "min(28rem, calc(100vw - 2rem))",
		},
	},
};
