"use client";

import { DirectionProvider, useDirection } from "@radix-ui/react-direction";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { readInterfaceDirection } from "@/components/messages/use-reading-layout";
import {
	documentDirection,
	type InterfaceDirection,
	INTERFACE_DIRECTION_CHOSEN_EVENT,
	resolveInterfaceDirection,
} from "./interface-direction-utils";

function subscribeToDocumentDirection(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
	return () => observer.disconnect();
}

function applyStoredDirection() {
	document.documentElement.dir = resolveInterfaceDirection(readInterfaceDirection(), navigator.language);
}

/**
 * Keeps `<html dir>` on the stored choice after the bootstrap script set it, and gives React the same answer: Radix reads
 * it for arrow keys, sub menus and tabs, and Kite's own components through `useInterfaceDirection`.
 *
 * Changing direction remounts the page's panels (`ui/resizable.tsx`), which throws away whatever is being typed there. So
 * a choice made here applies at once, as that is what was asked for, but one arriving in the background (another tab, the
 * account's layout from another device) only lands in storage and waits for the next navigation or page load.
 */
export function InterfaceDirectionProvider({ children }: { children: React.ReactNode }) {
	const direction = useSyncExternalStore(subscribeToDocumentDirection, documentDirection, () => "ltr" as const);
	const pathname = usePathname();

	// eslint-disable-next-line react-hooks/exhaustive-deps -- a navigation is the moment to catch up, whatever it changed.
	useLayoutEffect(applyStoredDirection, [pathname]);

	useEffect(() => {
		window.addEventListener(INTERFACE_DIRECTION_CHOSEN_EVENT, applyStoredDirection);
		return () => window.removeEventListener(INTERFACE_DIRECTION_CHOSEN_EVENT, applyStoredDirection);
	}, []);

	return <DirectionProvider dir={direction}>{children}</DirectionProvider>;
}

export function useInterfaceDirection(): InterfaceDirection {
	return useDirection();
}
