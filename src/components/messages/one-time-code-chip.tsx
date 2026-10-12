"use client";

import clsx from "clsx";
import { requestCopyCode } from "@/components/copy-code-host-utils";
import type { OneTimeCodeChipProps } from "./one-time-code-chip-types";

/**
 * Small copy-code chip for the message reader: shows the one-time code the
 * extractor found in the displayed text (computed by the caller) and copies it
 * on request. Renders nothing without a code.
 */
export function OneTimeCodeChip({ code, alignWide }: OneTimeCodeChipProps) {
	if (!code) return null;
	return (
		<div className={clsx(alignWide ? "pl-16" : "pl-10", "flex items-center gap-2 px-6 pb-2")}>
			<span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 font-mono text-sm font-semibold tracking-[0.2em] text-blue-900 select-all">
				{code}
			</span>
			<button
				type="button"
				onClick={() => requestCopyCode(code)}
				className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
			>
				Copy code
			</button>
		</div>
	);
}
