"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { DialogFrameProps } from "./dialog-frame-types";
import { useDialogFocus } from "./use-dialog-focus";

/** A hand-rolled modal panel: focus moves in and stays inside, and Escape asks it to close. */
export function DialogFrame({ label, onClose, children, ...props }: DialogFrameProps) {
	const ref = useRef<HTMLDivElement>(null);
	useDialogFocus(ref);

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		// A nested popover or select that handled Escape itself prevents the default; leave the dialog open then.
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.stopPropagation();
		onClose();
	}

	return (
		<div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} {...props}>
			{children}
		</div>
	);
}
