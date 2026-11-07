"use client";

import { useEffect } from "react";
import { dragHasFiles } from "./compose-drop-utils";

/**
 * While a composer is open, a file dropped anywhere that does not take it is ignored. Left alone, the browser opens
 * the file in this tab, and the page, the open message and the draft the sender is writing are gone. A drop zone
 * (the composer, Drive) cancels its own drag first, so the guard acts only on a drag nobody has taken.
 */
export function useFileDropGuard() {
	useEffect(() => {
		function ignore(event: DragEvent) {
			if (event.defaultPrevented || !dragHasFiles(event.dataTransfer)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
		}
		window.addEventListener("dragover", ignore);
		window.addEventListener("drop", ignore);
		return () => {
			window.removeEventListener("dragover", ignore);
			window.removeEventListener("drop", ignore);
		};
	}, []);
}
