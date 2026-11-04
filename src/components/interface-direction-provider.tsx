"use client";

import { DirectionProvider, useDirection } from "@radix-ui/react-direction";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { readInterfaceDirection } from "@/components/messages/use-reading-layout";
import { READING_LAYOUT_CHANGE_EVENT } from "@/components/messages/reading-layout-utils";
import { documentDirection, type InterfaceDirection, resolveInterfaceDirection } from "./interface-direction-utils";

function subscribeToDocumentDirection(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
	return () => observer.disconnect();
}

/**
 * Keeps `<html dir>` on the stored choice after the bootstrap script set it (the setting changed here or in another
 * tab, the account's layout arrived, the browser language changed), and gives React the same answer: Radix reads it
 * for arrow keys, sub menus and tabs, and Kite's own components through `useInterfaceDirection`.
 */
export function InterfaceDirectionProvider({ children }: { children: React.ReactNode }) {
	const direction = useSyncExternalStore(subscribeToDocumentDirection, documentDirection, () => "ltr" as const);

	useLayoutEffect(() => {
		const sync = () => {
			document.documentElement.dir = resolveInterfaceDirection(readInterfaceDirection(), navigator.language);
		};
		sync();
		window.addEventListener(READING_LAYOUT_CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		window.addEventListener("languagechange", sync);
		return () => {
			window.removeEventListener(READING_LAYOUT_CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
			window.removeEventListener("languagechange", sync);
		};
	}, []);

	return <DirectionProvider dir={direction}>{children}</DirectionProvider>;
}

export function useInterfaceDirection(): InterfaceDirection {
	return useDirection();
}
