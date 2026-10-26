"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Tooltip } from "@/components/ui/tooltip";
import { authFetch } from "@/lib/auth/client";
import type { WriteWithKiteComposer, WriteWithKiteSelection } from "./write-with-kite-types";

// The panel, its requests and HTML handling load only when the button is used.
const WriteWithKitePanel = lazy(() => import("./write-with-kite-panel"));

/** The editor's current selection, clipped to the text before the signature; null when there is none. */
function editorSelection(editor: HTMLElement): WriteWithKiteSelection | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0).cloneRange();
	if (!editor.contains(range.commonAncestorContainer)) return null;
	const signature = editor.querySelector("[data-kite-signature], [data-mailflare-signature]");
	if (signature) {
		if (signature.contains(range.startContainer)) return null;
		if (range.comparePoint(signature, 0) <= 0) range.setEndBefore(signature);
	}
	const text = range.toString();
	if (!text.trim()) return null;
	const holder = document.createElement("div");
	holder.appendChild(range.cloneContents());
	return { range, text, html: holder.innerHTML };
}

/**
 * The composer's Write with Kite button. It shows only when the assistant may write for this mailbox (assistant on,
 * a provider configured, an external provider allowed by the primary admin, and send access), and opens with ⌘J.
 */
export function WriteWithKite({ editorId, composer }: { editorId: string; composer: WriteWithKiteComposer }) {
	// The answer is kept per mailbox, so switching the From mailbox hides the button until its own answer arrives.
	const [checked, setChecked] = useState<{ mailboxId: string; available: boolean } | null>(null);
	const [open, setOpen] = useState<{ selection: WriteWithKiteSelection | null } | null>(null);
	const mailboxId = useSelectedMailbox().selectedMailbox?.id;
	const available = !!mailboxId && checked?.mailboxId === mailboxId && checked.available;

	useEffect(() => {
		let active = true;
		if (!mailboxId) return;
		void authFetch(`/api/agent/compose?mailboxId=${encodeURIComponent(mailboxId)}`, { redirectOnUnauthorized: false })
			.then(async (response) => {
				const data = (await response.json().catch(() => ({}))) as { available?: boolean };
				if (active) setChecked({ mailboxId, available: response.ok && data.available === true });
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [mailboxId]);

	function openPanel() {
		const editor = document.getElementById(editorId);
		if (editor) setOpen({ selection: editorSelection(editor) });
	}

	useEffect(() => {
		const editor = document.getElementById(editorId);
		if (!available || !editor) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
			event.preventDefault();
			setOpen({ selection: editorSelection(editor) });
		};
		editor.addEventListener("keydown", onKeyDown);
		return () => editor.removeEventListener("keydown", onKeyDown);
	}, [available, editorId]);

	if (!available) return null;
	return (
		<>
			<Tooltip label="Write with Kite (⌘J)">
				<button
					type="button"
					aria-label="Write with Kite"
					aria-expanded={!!open}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => (open ? setOpen(null) : openPanel())}
					className="rounded-md p-1.5 text-blue-600 hover:bg-blue-50 hover:text-blue-700 disabled:pointer-events-none disabled:opacity-50"
				>
					<Sparkles className="h-4 w-4" />
				</button>
			</Tooltip>
			{open && (
				<Suspense fallback={null}>
					<WriteWithKitePanel
						editorId={editorId}
						mailboxId={mailboxId}
						composer={composer}
						selection={open.selection}
						onClose={() => setOpen(null)}
					/>
				</Suspense>
			)}
		</>
	);
}
