"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ComposeAction } from "@/lib/agent/compose-types";
import { translateLanguages, warningText } from "./write-with-kite-utils";
import { useT } from "@/lib/i18n/use-t";
import { msg } from "@/lib/i18n/translator";

export type ComposeRun = { action?: ComposeAction; instruction?: string; language?: string };

const ACTIONS: { action: ComposeAction; label: string }[] = [
	{ action: "shorter", label: msg("Shorter") },
	{ action: "longer", label: msg("Longer") },
	{ action: "formal", label: msg("More formal") },
	{ action: "casual", label: msg("More casual") },
	{ action: "grammar", label: msg("Fix spelling and grammar") },
];

const FIELD = "h-8 rounded-md border border-neutral-200 px-2 outline-none focus:border-blue-400";

/** Write from a request: "What should this email say?" */
export function WriteRequest({ id, onRun }: { id: string; onRun: (run: ComposeRun) => void }) {
	const t = useT();
	const [prompt, setPrompt] = useState("");
	const write = () => prompt.trim() && onRun({ instruction: prompt });
	return (
		<div className="space-y-2">
			<label htmlFor={id} className="block text-neutral-700">
				{t("What should this email say?")}
			</label>
			<textarea
				id={id}
				value={prompt}
				maxLength={2_000}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) write();
				}}
				className="min-h-20 w-full rounded-lg border border-neutral-200 p-2 outline-none focus:border-blue-400"
			/>
			<Button type="button" size="sm" disabled={!prompt.trim()} onClick={write}>
				{t("Write")}
			</Button>
		</div>
	);
}

/** The rewrite actions for the selection or the whole body. */
export function RewriteActions({
	target,
	formatted,
	onRun,
}: {
	target: "selection" | "message";
	formatted: boolean;
	onRun: (run: ComposeRun) => void;
}) {
	const t = useT();
	const [custom, setCustom] = useState("");
	const [other, setOther] = useState("");
	const languages = translateLanguages(typeof navigator === "undefined" ? undefined : navigator.language);
	return (
		<div className="space-y-3">
			<p className="text-xs text-neutral-500">
				{target === "selection" ? t("Rewrite the selected text.") : t("Rewrite your text.")}{" "}
				{formatted && t("Bold, links and images in it will be lost; you can insert the result below instead.")}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{ACTIONS.map((item) => (
					<Button
						key={item.action}
						type="button"
						size="sm"
						variant="outline"
						onClick={() => onRun({ action: item.action })}
					>
						{t(item.label)}
					</Button>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Translate to")}>
				<span className="text-xs text-neutral-500">{t("Translate to")}</span>
				{languages.map((language) => (
					<Button
						key={language}
						type="button"
						size="sm"
						variant="outline"
						onClick={() => onRun({ action: "translate", language })}
					>
						{language}
					</Button>
				))}
				<input
					aria-label={t("Other language")}
					placeholder={t("Other…")}
					value={other}
					maxLength={40}
					onChange={(event) => setOther(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && other.trim()) onRun({ action: "translate", language: other.trim() });
					}}
					className={`${FIELD} w-28`}
				/>
			</div>
			<div className="flex items-center gap-1.5">
				<input
					aria-label={t("Custom instruction")}
					placeholder={t("Custom: tell Kite how to rewrite it")}
					value={custom}
					maxLength={300}
					onChange={(event) => setCustom(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && custom.trim()) onRun({ action: "custom", instruction: custom });
					}}
					className={`${FIELD} flex-1`}
				/>
				<Button
					type="button"
					size="sm"
					disabled={!custom.trim()}
					onClick={() => onRun({ action: "custom", instruction: custom })}
				>
					{t("Rewrite")}
				</Button>
			</div>
		</div>
	);
}

/**
 * The streamed preview, then the checked text with its warnings. Screen readers hear about it once, when it is
 * done, not at every streamed word.
 */
export function ComposePreview({ text, warnings, done }: { text: string; warnings: string[]; done: boolean }) {
	const t = useT();
	return (
		<>
			<p role="status" className="sr-only">
				{done ? t("Kite's text is ready. Review it, then insert or discard it.") : ""}
			</p>
			<div
				role="region"
				aria-busy={!done}
				aria-label={t("Preview")}
				className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-100 p-2 text-neutral-900"
			>
				{text || t("Writing…")}
			</div>
			{warnings.map((warning) => (
				<p key={warning} className="text-xs text-amber-700">
					{warningText(warning)}
				</p>
			))}
		</>
	);
}

/** Insert or Replace, Insert below, Try again and Discard, each shown only when it applies. */
export function ResultActions({
	insertLabel,
	text,
	below,
	offerBelow,
	retry,
	onInsertText,
	onRetry,
	onDiscard,
}: {
	insertLabel: string;
	/** The checked text, once there is one to insert. */
	text: string | null;
	below: boolean;
	offerBelow: boolean;
	retry: ComposeRun | null;
	onInsertText: (text: string, below: boolean) => void;
	onRetry: (run: ComposeRun) => void;
	onDiscard: () => void;
}) {
	const t = useT();
	return (
		<div className="flex flex-wrap gap-1.5">
			{text !== null && (
				<Button type="button" size="sm" onClick={() => onInsertText(text, below)}>
					{insertLabel}
				</Button>
			)}
			{text !== null && offerBelow && (
				<Button type="button" size="sm" variant="outline" onClick={() => onInsertText(text, true)}>
					{t("Insert below")}
				</Button>
			)}
			{retry && (
				<Button type="button" size="sm" variant="outline" onClick={() => onRetry(retry)}>
					{t("Try again")}
				</Button>
			)}
			<Button type="button" size="sm" variant="outline" onClick={onDiscard}>
				{t("Discard")}
			</Button>
		</div>
	);
}

/**
 * After an insert: a reminder to review, and Undo, which restores the message as it was before the insert; when
 * the message was edited since, the note says that Undo drops those edits too.
 */
export function InsertedNote({
	editedSince,
	onUndo,
	onDone,
}: {
	editedSince: boolean;
	onUndo: () => void;
	onDone: () => void;
}) {
	const t = useT();
	return (
		<div className="flex items-center gap-2">
			<p role="status" className="flex-1 text-neutral-700">
				{editedSince
					? t(
							"You changed the message after inserting. Undo restores it as it was before Kite's text, without those changes.",
						)
					: t("Kite's text is in your message. Review it before you send.")}
			</p>
			<Button type="button" size="sm" variant="outline" onClick={onUndo}>
				{t("Undo")}
			</Button>
			<Button type="button" size="sm" onClick={onDone}>
				{t("Done")}
			</Button>
		</div>
	);
}
