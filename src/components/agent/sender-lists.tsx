"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { senderAddressError, type SenderListName } from "@/lib/agent/auto-read/sender-lists-utils";
import type { SenderListEditorProps, SenderListsProps } from "./auto-read-settings-types";
import { saveSenderListEdit, SENDER_LIST_TEXT } from "./auto-read-settings-utils";

const inputClass =
	"min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white p-2 outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-60";

function SenderListEditor({ mailboxId, list, senders, disabled, onChange }: SenderListEditorProps) {
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const text = SENDER_LIST_TEXT[list];
	const headingId = `sender-list-${list}-${mailboxId}`;
	const locked = disabled || busy;

	async function edit(change: "add" | "remove", sender: string) {
		setBusy(true);
		setError("");
		try {
			onChange((await saveSenderListEdit(mailboxId, list, change, sender)).senders);
			if (change === "add") setInput("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not change the list");
		} finally {
			setBusy(false);
		}
	}

	function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const problem = senderAddressError(input);
		if (problem) return setError(problem);
		void edit("add", input);
	}

	return (
		<section aria-labelledby={headingId} className="space-y-2" data-sender-list={list}>
			<p id={headingId} className="text-neutral-800">
				{text.title}
			</p>
			<p className="text-xs text-neutral-500">{text.description}</p>
			{senders.length === 0 ? (
				<p className="text-xs text-neutral-500">{text.empty}</p>
			) : (
				<ul aria-labelledby={headingId} className="divide-y divide-neutral-200 rounded-xl border border-neutral-200">
					{senders.map((sender) => (
						<li key={sender} className="flex items-center justify-between gap-2 py-1 pl-2 pr-1">
							<span className="min-w-0 truncate">{sender}</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={locked}
								aria-label={`Remove ${sender}`}
								onClick={() => void edit("remove", sender)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			<form noValidate onSubmit={add} className="flex gap-2">
				<input
					className={inputClass}
					type="email"
					autoComplete="off"
					placeholder="name@example.com"
					aria-label={text.inputLabel}
					value={input}
					disabled={locked}
					onChange={(event) => {
						setInput(event.target.value);
						setError("");
					}}
				/>
				<Button type="submit" size="sm" variant="outline" disabled={locked || !input.trim()}>
					Add
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</section>
	);
}

const LISTS: readonly SenderListName[] = ["trusted", "muted"];

/** Trusted and muted senders; each add or remove is saved at once, apart from the Save button. */
export function SenderLists({ mailboxId, senders, disabled, onChange }: SenderListsProps) {
	return (
		<>
			{LISTS.map((list) => (
				<SenderListEditor
					key={list}
					mailboxId={mailboxId}
					list={list}
					senders={senders[list]}
					disabled={disabled}
					onChange={(next) => onChange({ ...senders, [list]: next })}
				/>
			))}
		</>
	);
}
