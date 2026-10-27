"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCompose } from "./compose-context";
import { LazyComposeForm } from "./compose-form-lazy";
import { InlineComposerHostContext } from "./inline-composer-host";

/**
 * The reader's reply area, after Zero's reply composer: the reply box (`collapsed`) until a reply, reply all or
 * forward starts, then an empty slot that the docked composer (InlineComposerPortal) moves into.
 */
export function InlineReplyComposer({ messageId, collapsed }: { messageId: string; collapsed: ReactNode }) {
	const { open, placement, inlineFor, setInlineSlot } = useCompose();
	const here = open && placement === "inline" && inlineFor === messageId;
	const slotRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (element) setInlineSlot({ messageId, element });
			else setInlineSlot(null);
		},
		[messageId, setInlineSlot],
	);
	if (!here) return collapsed;
	return <div ref={slotRef} data-inline-composer-slot="" className="shrink-0" />;
}

/** Wraps a reader so replies started in it (toolbar, shortcuts, the reply box) dock under its message. */
export function InlineComposerHost({ messageId, children }: { messageId: string; children: ReactNode }) {
	return <InlineComposerHostContext.Provider value={{ messageId }}>{children}</InlineComposerHostContext.Provider>;
}

/** Where the docked composer waits while no reader shows it: off screen, but its fixed send and undo bars stay up. */
function parkingElement() {
	let element = document.getElementById("kite-inline-composer-parking");
	if (!element) {
		element = document.createElement("div");
		element.id = "kite-inline-composer-parking";
		element.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:0;overflow:visible;";
		document.body.appendChild(element);
	}
	return element;
}

/**
 * Keeps the docked composer mounted across readers. It renders into one container that is moved into the open
 * message's slot, or parked, so leaving the message never remounts it: a reply that is sending or offering undo
 * keeps its bar, an undo while no reader hosts it reopens the draft in the floating composer, and an idle reply
 * collapses with its draft kept when its reader goes away.
 */
export function InlineComposerPortal() {
	const { open, placement, draftId, inlineFor, inlineSlot, collapseInline, finishInline, popOut } = useCompose();
	const [container] = useState(() => {
		if (typeof document === "undefined") return null;
		const element = document.createElement("div");
		element.className = "contents";
		return element;
	});
	const active = open && placement === "inline";
	const slot = active && inlineSlot?.messageId === inlineFor ? inlineSlot.element : null;
	const busy = useRef(false);
	const wasShown = useRef(false);
	const shownRef = useRef<HTMLElement | null>(null);

	useLayoutEffect(() => {
		shownRef.current = slot;
		if (!container) return;
		const target = slot ?? parkingElement();
		if (container.parentElement !== target) target.appendChild(container);
		if (slot) wasShown.current = true;
	}, [container, slot]);

	// The reader went away (another message, another page); an idle reply collapses with its draft kept.
	useEffect(() => {
		if (!active) {
			wasShown.current = false;
			return;
		}
		if (!slot && wasShown.current && !busy.current) collapseInline();
	}, [active, slot, collapseInline]);

	if (!active || !container) return null;
	return createPortal(
		<LazyComposeForm
			key={draftId ?? "new"}
			mode="inline"
			draftIdToLoad={draftId}
			inline={{
				collapse: (id) => collapseInline(id),
				finish: (id) => finishInline(id),
				popOut: (id) => popOut(id),
				busyChange: (value) => {
					busy.current = value;
					if (!value && !shownRef.current && wasShown.current) collapseInline();
				},
				undone: (id) => {
					if (!shownRef.current) popOut(id);
				},
			}}
		/>,
		container,
	);
}
