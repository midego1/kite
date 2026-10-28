import clsx from "clsx";

/**
 * The panel's frame and header. Docked beside the page it is a panel like the message list and the reader
 * (same border, radius and shadow), with a header as tall as the list's so their bottom borders line up;
 * in the floating window it keeps its own look.
 */
export function agentPanelStyle(docked: boolean | undefined) {
	return {
		section: clsx(
			"flex h-full w-full min-w-0 flex-col overflow-hidden bg-white text-neutral-900 max-md:rounded-b-none max-md:border-0 max-md:shadow-none",
			docked
				? "rounded-xl border border-neutral-200 shadow-xs"
				: "rounded-2xl border border-blue-200/70 shadow-xl shadow-blue-900/10",
		),
		header: clsx(
			"flex shrink-0 items-center justify-between gap-1 border-b pl-3 pr-2",
			docked ? "h-14 border-neutral-200" : "h-16 border-blue-100 bg-gradient-to-r from-blue-50 to-blue-100/50",
		),
	};
}
