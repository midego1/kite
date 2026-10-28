import type { ToasterProps } from "react-hot-toast";

/**
 * Every transient notice (react-hot-toast, the send and undo-send bars, the composer's result toast) sits in the
 * bottom-right corner, lifted above the reader's reply box, the docked composer's footer and the floating assistant
 * button, so it never covers them. `--kite-toast-bottom` and `--kite-toast-inset` are set in globals.css (phones get
 * a smaller inset and the safe area).
 */
export const TOAST_CORNER_CLASS = "fixed bottom-[var(--kite-toast-bottom)] right-[var(--kite-toast-inset)]";

/** The card every toast wears. The palette classes are remapped by each look and in dark mode, so it follows the theme. */
export const TOAST_SURFACE_CLASS =
	"rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-900 shadow-lg";

/** The action inside a toast (Reload, Undo): the primary button, which stays legible in light and dark. */
export const TOAST_ACTION_CLASS =
	"shrink-0 rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

/** react-hot-toast styles toasts inline (white card, #363636 text), so the theme variables are applied here instead. */
export const TOASTER_PROPS: ToasterProps = {
	position: "bottom-right",
	containerStyle: {
		top: "auto",
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
