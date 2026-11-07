"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { dragHasFiles, namePastedFiles, pastedFiles } from "./compose-drop-utils";

/**
 * While a composer is open, a file dropped anywhere that does not take it is ignored. Left alone, the browser opens
 * the file in this tab, and the page, the open message and the draft the sender is writing are gone. A drop zone
 * (the composer, Drive) cancels its own drag first, so the guard acts only on a drag nobody has taken. It rests while the
 * composer is minimized, and leaves file inputs alone.
 */
function useFileDropGuard(active: boolean) {
	useEffect(() => {
		if (!active) return;
		function ignore(event: DragEvent | globalThis.DragEvent) {
			if (event.defaultPrevented || !dragHasFiles(event.dataTransfer)) return;
			// A file input takes a dropped file by itself (Import mail); cancelling the drop would stop that.
			if (event.target instanceof Element && event.target.closest("input[type='file']")) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
		}
		window.addEventListener("dragover", ignore);
		window.addEventListener("drop", ignore);
		return () => {
			window.removeEventListener("dragover", ignore);
			window.removeEventListener("drop", ignore);
		};
	}, [active]);
}

/**
 * Files dragged onto or pasted into the composer form. `busy` (a draft loading or a send running) refuses them and a
 * minimized composer takes none. Spread `frameHandlers` on the form; `dragging` says whether to draw the drop target.
 */
export function useComposerFiles({
	busy,
	minimized,
	addAttachments,
	attachmentNames,
}: {
	busy: boolean;
	minimized: boolean;
	addAttachments: (files: File[]) => void;
	/** The names of the files already on the message, so a pasted file never repeats one. */
	attachmentNames: () => string[];
}) {
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);
	useFileDropGuard(!minimized);

	function stopDragging() {
		depth.current = 0;
		setDragging(false);
	}

	function onDragEnter(event: DragEvent<HTMLFormElement>) {
		if (!dragHasFiles(event.dataTransfer)) return;
		depth.current += 1;
		if (!busy) setDragging(true);
	}

	function onDragOver(event: DragEvent<HTMLFormElement>) {
		if (!dragHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = busy ? "none" : "copy";
		// A dragenter the form did not see (the counter drifted) still shows the target.
		if (!busy && !dragging) setDragging(true);
	}

	function onDragLeave(event: DragEvent<HTMLFormElement>) {
		// Not judged by the drag's types: a browser may hide them while a drag leaves, and the target would stay up.
		if (depth.current === 0) return;
		depth.current -= 1;
		const into = event.relatedTarget;
		// Safari reports no related target, so the counter decides there; elsewhere leaving for a place outside ends it at once.
		if (depth.current === 0 || (into instanceof Node && !event.currentTarget.contains(into))) stopDragging();
	}

	function onDrop(event: DragEvent<HTMLFormElement>) {
		if (!dragHasFiles(event.dataTransfer)) return;
		// Before anything else can act on it: the editor would insert the file's name and a bare input would open it.
		event.preventDefault();
		event.stopPropagation();
		stopDragging();
		if (!busy) addAttachments(Array.from(event.dataTransfer.files));
	}

	/** A screenshot or a copied file is attached like a picked one; a text paste is left to the editor and the fields. */
	function onPaste(event: ClipboardEvent<HTMLFormElement>) {
		const files = pastedFiles(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		event.stopPropagation();
		if (!busy) addAttachments(namePastedFiles(files, attachmentNames()));
	}

	return {
		dragging: dragging && !minimized,
		stopDragging,
		frameHandlers: minimized
			? {}
			: {
					onDragEnterCapture: onDragEnter,
					onDragOverCapture: onDragOver,
					onDragLeaveCapture: onDragLeave,
					onDropCapture: onDrop,
					onPasteCapture: onPaste,
				},
	};
}
