"use client";

import { useEffect, type ReactNode } from "react";
import { useCompose } from "./compose-context";
import { LazyComposeForm } from "./compose-form-lazy";
import { InlineComposerHostContext } from "./inline-composer-host";

/**
 * The reader's reply area, after Zero's reply composer: the reply box (`collapsed`) until a reply, reply all or
 * forward starts, then the same composer as everywhere else, docked under the message. Opening another message
 * collapses it; the autosave has kept the draft, which Drafts and the reply's pop-out can pick up again.
 */
export function InlineReplyComposer({ messageId, collapsed }: { messageId: string; collapsed: ReactNode }) {
	const { open, draftId, placement, inlineFor, closeComposer, collapseInline, popOut } = useCompose();
	const docked = open && placement === "inline";
	const here = docked && inlineFor === messageId;

	useEffect(() => {
		if (docked && inlineFor !== messageId) collapseInline();
	}, [docked, inlineFor, messageId, collapseInline]);

	if (!here) return collapsed;
	return (
		<LazyComposeForm
			key={draftId ?? "new"}
			mode="inline"
			draftIdToLoad={draftId}
			onClose={collapseInline}
			onSent={closeComposer}
			onPopOut={popOut}
		/>
	);
}

/** Wraps a reader so replies started in it (toolbar, shortcuts, the reply box) dock under its message. */
export function InlineComposerHost({ messageId, children }: { messageId: string; children: ReactNode }) {
	return <InlineComposerHostContext.Provider value={{ messageId }}>{children}</InlineComposerHostContext.Provider>;
}
