import { X } from "lucide-react";
import { FOCUS_RING } from "./home-mailbox-sidebar";
import type { HomeMailboxAction, HomeMailboxState } from "./home-mailbox-types";

/** The toast and the composer of the mailbox. Sending goes nowhere: the composer says so and closes. */
export function HomeToast({
	state,
	dispatch,
}: {
	state: HomeMailboxState;
	dispatch: (action: HomeMailboxAction) => void;
}) {
	if (!state.toast) return null;
	return (
		<div
			role="status"
			className="absolute bottom-4 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm text-white shadow-lg"
		>
			<span className="min-w-0">{state.toast.text}</span>
			<button
				type="button"
				aria-label="Dismiss"
				onClick={() => dispatch({ type: "dismissToast" })}
				className={`-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded ${FOCUS_RING}`}
			>
				<X className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

export function HomeComposer({
	state,
	dispatch,
}: {
	state: HomeMailboxState;
	dispatch: (action: HomeMailboxAction) => void;
}) {
	const composer = state.composer;
	if (!composer) return null;
	return (
		<div
			role="dialog"
			aria-label="New message"
			className="absolute inset-x-0 bottom-0 z-40 flex max-h-[85%] flex-col rounded-t-2xl border border-neutral-200 bg-white shadow-2xl md:inset-x-auto md:bottom-4 md:right-4 md:w-[440px] md:rounded-2xl"
		>
			<div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900">
				New message
				<button
					type="button"
					aria-label="Close"
					onClick={() => dispatch({ type: "closeComposer" })}
					className={`-mr-1 rounded-md p-1 ${FOCUS_RING}`}
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			<div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-3 text-sm">
				<label className="flex items-center gap-2 border-b border-neutral-200 pb-2 focus-within:border-blue-500">
					<span className="w-14 text-neutral-500">To</span>
					<input
						defaultValue={composer.to}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 focus:outline-none"
					/>
				</label>
				<label className="flex items-center gap-2 border-b border-neutral-200 pb-2 focus-within:border-blue-500">
					<span className="w-14 text-neutral-500">Subject</span>
					<input
						defaultValue={composer.subject}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 focus:outline-none"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="sr-only">Message</span>
					<textarea rows={6} className="resize-none bg-transparent text-neutral-900 focus:outline-none" />
				</label>
				<div className="flex items-center justify-between gap-3">
					<p className="text-xs text-neutral-500">Nothing leaves this page.</p>
					<button
						type="button"
						onClick={() => dispatch({ type: "send" })}
						className={`rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 ${FOCUS_RING}`}
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}
