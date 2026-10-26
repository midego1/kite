"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Sparkles, X } from "lucide-react";
import { htmlToPlainText } from "./rich-text-utils";
import { insertComposeText, selectionIntact } from "./write-with-kite-insert";
import { streamCompose } from "./write-with-kite-request";
import type { WriteWithKitePanelProps } from "./write-with-kite-types";
import { hasRichFormatting, splitSignature } from "./write-with-kite-utils";
import {
	ComposePreview,
	InsertedNote,
	ResultActions,
	RewriteActions,
	WriteRequest,
	type ComposeRun,
} from "./write-with-kite-views";

type Phase =
	| { name: "ask" }
	| { name: "running"; preview: string }
	| { name: "done"; text: string; warnings: string[] }
	| { name: "error"; message: string }
	| { name: "inserted"; previous: string };

/** Esc aborts and closes the panel, not the composer; Enter never reaches the compose form, which would send. */
function panelKeyDown(event: KeyboardEvent<HTMLDivElement>, close: () => void) {
	if (event.key !== "Enter" && event.key !== "Escape") return;
	event.stopPropagation();
	if (event.nativeEvent.isComposing) return;
	const typing = event.target instanceof HTMLTextAreaElement && !event.metaKey && !event.ctrlKey;
	if (event.key === "Escape" || !typing) event.preventDefault();
	if (event.key === "Escape") close();
}

/** What the panel works on: the selection, the body without its signature, or nothing yet (write mode). */
function panelSource(html: string, selection: WriteWithKitePanelProps["selection"]) {
	const body = splitSignature(html).body;
	const bodyText = htmlToPlainText(body).trim();
	const mode: "write" | "rewrite" = selection || bodyText ? "rewrite" : "write";
	const sourceHtml = selection?.html ?? body;
	return {
		mode,
		sourceText: selection?.text ?? bodyText,
		sourceHtml,
		formatted: mode === "rewrite" && hasRichFormatting(sourceHtml),
		target: selection ? "the selected text" : "your text",
	};
}

/** The composer fields a request carries besides the text; the server loads the replied-to email itself. */
function composerContext(composer: WriteWithKitePanelProps["composer"]) {
	return {
		subject: composer.subject,
		to: composer.to,
		inReplyTo: composer.threading?.inReplyTo ?? null,
		threadId: composer.threading?.threadId ?? null,
	};
}

/** Which result buttons apply in this phase. */
function resultActions(
	phase: Phase,
	state: { mode: "write" | "rewrite"; formatted: boolean; changed: boolean; last: ComposeRun | null },
) {
	const done = phase.name === "done" ? phase : null;
	return {
		insertLabel: state.mode === "write" ? "Insert" : state.changed ? "Insert below" : "Replace",
		text: done?.text ?? null,
		below: state.changed,
		offerBelow: !!done && state.formatted && !state.changed,
		retry: phase.name === "running" ? null : state.last,
	};
}

/**
 * Write with Kite: writes the body from a short request, or rewrites the selection (or the whole body) as asked.
 * The answer streams into a preview and enters the editor only when the user clicks; the quote, which lives outside
 * the editor, and the signature block are never sent or changed.
 */
export default function WriteWithKitePanel({
	editorId,
	mailboxId,
	composer,
	selection,
	onClose,
}: WriteWithKitePanelProps) {
	const { mode, sourceText, sourceHtml, formatted, target } = panelSource(composer.html, selection);
	const [phase, setPhase] = useState<Phase>({ name: "ask" });
	const [last, setLast] = useState<ComposeRun | null>(null);
	const controller = useRef<AbortController | null>(null);
	const panel = useRef<HTMLDivElement | null>(null);

	useEffect(() => () => controller.current?.abort(), []);

	// Each step moves focus into the panel: the request field, else its first button after the Close button.
	useEffect(() => {
		panel.current?.querySelector<HTMLElement>("textarea, button:not([aria-label='Close'])")?.focus();
	}, [phase.name]);

	function close() {
		controller.current?.abort();
		onClose();
	}

	// Esc closes the panel wherever focus is while it is open, before the composer can treat it as its own.
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			controller.current?.abort();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	async function run(request: ComposeRun) {
		controller.current?.abort();
		const abort = new AbortController();
		controller.current = abort;
		setLast(request);
		setPhase({ name: "running", preview: "" });
		const answer = await streamCompose(
			{
				mailboxId,
				mode,
				...request,
				...(mode === "rewrite" ? { text: sourceText } : {}),
				...composerContext(composer),
			},
			abort.signal,
			(preview) => setPhase({ name: "running", preview }),
		).catch((error: unknown) => ({
			ok: false as const,
			message: error instanceof Error ? error.message : "Kite could not write this.",
		}));
		if (abort.signal.aborted) return;
		setPhase(answer.ok ? { name: "done", ...answer } : { name: "error", message: answer.message });
	}

	function insert(text: string, below: boolean) {
		const previous = composer.html;
		const originalHtml = last?.action === "translate" ? sourceHtml : null;
		insertComposeText({ editorId, composer, selection, text, originalHtml, below });
		setPhase({ name: "inserted", previous });
	}

	const changed = phase.name === "done" && !!selection && !selectionIntact(editorId, selection);

	return (
		// Not a <form>: the panel sits inside the compose form, and a nested form's submit would send the message.
		<div
			ref={panel}
			role="dialog"
			aria-label="Write with Kite"
			onKeyDown={(event) => panelKeyDown(event, close)}
			className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-[min(28rem,70vh)] space-y-2 overflow-y-auto rounded-xl border border-blue-100 bg-white p-3 text-sm shadow-lg dark:border-blue-900"
		>
			<div className="flex items-center gap-2">
				<Sparkles className="h-4 w-4 text-blue-600" />
				<p className="flex-1 font-medium text-neutral-900">Write with Kite</p>
				<button
					type="button"
					aria-label="Close"
					onClick={close}
					className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			{phase.name === "ask" &&
				(mode === "write" ? (
					<WriteRequest id={`${editorId}-kite-prompt`} onRun={(request) => void run(request)} />
				) : (
					<RewriteActions target={target} formatted={formatted} onRun={(request) => void run(request)} />
				))}
			{phase.name === "running" && <ComposePreview text={phase.preview} warnings={[]} />}
			{phase.name === "done" && <ComposePreview text={phase.text} warnings={phase.warnings} />}
			{changed && (
				<p className="text-xs text-amber-700">
					The selected text changed meanwhile, so Kite adds its text below instead.
				</p>
			)}
			{phase.name === "error" && (
				<p role="alert" className="text-red-700">
					{phase.message}
				</p>
			)}
			{phase.name === "inserted" && (
				<InsertedNote
					onUndo={() => {
						composer.setHtml(phase.previous);
						onClose();
					}}
					onDone={onClose}
				/>
			)}
			{phase.name !== "ask" && phase.name !== "inserted" && (
				<ResultActions
					{...resultActions(phase, { mode, formatted, changed, last })}
					onInsertText={insert}
					onRetry={(request) => void run(request)}
					onDiscard={close}
				/>
			)}
		</div>
	);
}
