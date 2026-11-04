"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
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

/** ⌘J on Apple devices, Ctrl+J elsewhere; both open the panel on any platform. */
function shortcutLabel(): string {
	const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
	return /Mac|iPhone|iPad/i.test(platform) ? "⌘J" : "Ctrl+J";
}

/**
 * The composer's Write with Kite button. It shows only when the assistant may write for this mailbox (assistant on,
 * a provider configured, an external provider allowed by the primary admin, and send access), and opens with ⌘J.
 */
export function WriteWithKite({
	editorId,
	mailboxId,
	composer,
}: {
	editorId: string;
	/** The mailbox the composer sends from, which the sidebar's choice does not decide. */
	mailboxId: string | undefined;
	composer: WriteWithKiteComposer;
}) {
	// The composer's own mailbox (its From), not the sidebar's. The answer is kept per mailbox, so changing From hides
	// the button until that mailbox's answer arrives.
	const [checked, setChecked] = useState<{ mailboxId: string; available: boolean } | null>(null);
	const [openState, setOpen] = useState<{ mailboxId: string; selection: WriteWithKiteSelection | null } | null>(null);
	// A panel belongs to the mailbox it was opened for: changing From closes it, and it does not come back with the answer.
	const open = openState?.mailboxId === mailboxId ? openState : null;
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
		if (editor && mailboxId) setOpen({ mailboxId, selection: editorSelection(editor) });
	}

	useEffect(() => {
		const editor = document.getElementById(editorId);
		if (!available || !editor) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
			event.preventDefault();
			if (mailboxId) setOpen({ mailboxId, selection: editorSelection(editor) });
		};
		editor.addEventListener("keydown", onKeyDown);
		return () => editor.removeEventListener("keydown", onKeyDown);
	}, [available, editorId, mailboxId]);

	if (!available) return null;
	return (
		<>
			<Tooltip label={`Write with Kite (${shortcutLabel()})`}>
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
						onClose={() => {
							setOpen(null);
							// Focus goes back to where the user was writing.
							document.getElementById(editorId)?.focus();
						}}
					/>
				</Suspense>
			)}
		</>
	);
}
