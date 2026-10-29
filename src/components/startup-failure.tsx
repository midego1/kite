"use client";

import type { StartupFailureProps } from "./loading-transition-types";

/** AuthGuard's error state: the session check failed after its retries. */
export function StartupFailure({ onRetry, onContinue }: StartupFailureProps) {
	return (
		<div role="alert" className="text-center text-sm text-neutral-600">
			<p className="font-medium text-neutral-900">Kite could not reach the server.</p>
			<p className="mt-1">It tries again when you come back to this tab or your connection returns.</p>
			<div className="mt-4 flex justify-center gap-2">
				<button
					type="button"
					className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
					onClick={onRetry}
				>
					Try again
				</button>
				<button
					type="button"
					className="rounded-lg px-4 py-2 text-neutral-700 hover:bg-neutral-200"
					onClick={onContinue}
				>
					Continue anyway
				</button>
			</div>
		</div>
	);
}
