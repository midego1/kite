"use client";

import toast from "react-hot-toast";
import type { ProgressToast } from "./progress-toast-types";

function ProgressContent({ label, done, total }: { label: string; done: number; total: number }) {
	const fraction = total > 0 ? Math.min(1, done / total) : 0;
	return (
		<span className="flex w-64 flex-col gap-2 text-sm">
			<span className="flex items-center justify-between gap-3">
				<span>{label}</span>
				<span className="tabular-nums text-neutral-500">
					{done} of {total}
				</span>
			</span>
			<span
				className="block h-1.5 w-full overflow-hidden rounded-full bg-neutral-200"
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={done}
			>
				<span
					className="block h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out"
					style={{ width: `${fraction * 100}%` }}
				/>
			</span>
		</span>
	);
}

/** A toast with a progress bar that stays until the work finishes, then turns into a success or error toast. */
export function showProgressToast(label: string, total: number): ProgressToast {
	let currentTotal = total;
	const id = toast(() => <ProgressContent label={label} done={0} total={currentTotal} />, {
		duration: Infinity,
		ariaProps: { role: "status", "aria-live": "polite" },
	});
	return {
		update(done, nextTotal) {
			if (nextTotal !== undefined) currentTotal = nextTotal;
			toast(() => <ProgressContent label={label} done={done} total={currentTotal} />, {
				id,
				duration: Infinity,
				ariaProps: { role: "status", "aria-live": "polite" },
			});
		},
		succeed(message) {
			toast.success(message, { id, duration: 4000 });
		},
		fail(message) {
			toast.error(message, { id, duration: 6000 });
		},
	};
}
