"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { SelectedMessage } from "./types";

type Survivor = { messages: SelectedMessage[]; identity: string | null };

/**
 * What the layout that just unmounted had checked, handed to the one that mounts next. Set only when the page's
 * direction changed under it, which is the one unmount that is not the user leaving the list.
 */
let survivor: Survivor | null = null;

function documentDirection() {
	return typeof document === "undefined" ? "" : document.documentElement.dir;
}

/**
 * Switching to or from a right-to-left language remounts the whole shell (`ui/resizable.tsx` rebuilds its panel
 * group because the library only orders panels on mount), which would throw away the messages the user had checked.
 * Leaving the page any other way still clears them, so this keeps the selection only when `<html dir>` is not the
 * direction the layout mounted with. `identityRef` is the list the selection belongs to (`claimList`), restored
 * with it so the new list does not mistake the same list for a different one and clear what it just got back.
 */
export function useSurvivingSelection(
	selectedMessages: SelectedMessage[],
	setSelectedMessages: Dispatch<SetStateAction<SelectedMessage[]>>,
	identityRef: MutableRefObject<string | null>,
) {
	const latest = useRef(selectedMessages);
	const mountedDirection = useRef("");
	useEffect(() => {
		latest.current = selectedMessages;
	}, [selectedMessages]);
	useLayoutEffect(() => {
		mountedDirection.current = documentDirection();
		const kept = survivor;
		survivor = null;
		if (kept && kept.messages.length > 0) {
			identityRef.current = kept.identity;
			setSelectedMessages(kept.messages);
		}
		return () => {
			survivor =
				latest.current.length > 0 && documentDirection() !== mountedDirection.current
					? { messages: latest.current, identity: identityRef.current }
					: null;
		};
		// Once per mount: the refs and the setter are stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}
