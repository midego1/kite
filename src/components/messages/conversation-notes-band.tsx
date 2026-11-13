"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Pencil, Pin, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { NOTE_MAX_LENGTH } from "@/lib/notes/note-utils";
import type { ConversationNote } from "@/lib/notes/notes-types";
import { formatUserDate } from "@/lib/time/utils";
import { useT } from "@/lib/i18n/use-t";
import { LinkifiedText } from "./linkified-text";
import type { ConversationNotesController, NoteEmail } from "./conversation-notes-types";
import { authorInitials, NOTES_BAND_ID, pinnedEmail } from "./conversation-notes-utils";

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

/** Ctrl+Enter or ⌘+Enter saves, Escape cancels, in every note editor. */
function editorKeys(save: () => void, cancel?: () => void) {
	return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			save();
		} else if (event.key === "Escape" && cancel) {
			event.preventDefault();
			cancel();
		}
	};
}

/** Scrolls the reader to an email of the conversation, when it is on the page. */
function showEmail(messageId: string) {
	document
		.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
		?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function PinChip({ note, emails }: { note: ConversationNote; emails: readonly NoteEmail[] }) {
	const t = useT();
	const email = pinnedEmail(note, emails);
	if (!email) return null;
	const label =
		email.sender && email.createdAt
			? t("About the email from {name}, {date}", {
					name: email.sender,
					date: formatUserDate(email.createdAt, DATE_FORMAT),
				})
			: t("About an email in this conversation");
	return (
		<button
			type="button"
			onClick={() => showEmail(email.id)}
			className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-amber-300/80 bg-white/70 px-2 py-0.5 text-xs text-neutral-700 hover:bg-white"
		>
			<Pin aria-hidden className="h-3 w-3 shrink-0" />
			<span className="truncate">{label}</span>
		</button>
	);
}

function NoteItem({
	note,
	emails,
	controller,
}: {
	note: ConversationNote;
	emails: readonly NoteEmail[];
	controller: ConversationNotesController;
}) {
	const t = useT();
	const confirm = useConfirm();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(note.body);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const authorName = note.author?.name || t("Former member");

	const save = async () => {
		const body = draft.trim();
		if (!body || busy) return;
		setBusy(true);
		const failed = await controller.update(note.id, body);
		setBusy(false);
		setError(failed);
		if (!failed) setEditing(false);
	};
	const remove = async () => {
		const confirmed = await confirm({
			title: t("Delete this note?"),
			description: t("Everyone with access to this mailbox will stop seeing it."),
			confirmLabel: t("Delete"),
		});
		if (!confirmed) return;
		setError(await controller.remove(note.id));
	};

	return (
		<li className="flex gap-2.5 py-2" data-note-id={note.id}>
			<span
				aria-hidden
				className="mt-0.5 grid h-7 w-7 shrink-0 place-content-center rounded-full bg-amber-200 text-xs font-semibold text-amber-900"
			>
				{authorInitials(note.author?.name)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="font-medium text-neutral-900">{authorName}</span>
					<time dateTime={note.createdAt} className="text-xs text-neutral-500">
						{formatUserDate(note.createdAt, DATE_FORMAT)}
					</time>
					{note.edited && <span className="text-xs text-neutral-500">{t("(edited)")}</span>}
					<span className="ms-auto flex items-center gap-0.5">
						{note.canEdit && !editing && (
							<Tooltip label={t("Edit note")}>
								<button
									type="button"
									aria-label={t("Edit note")}
									onClick={() => {
										setDraft(note.body);
										setEditing(true);
									}}
									className="rounded p-1 text-neutral-500 hover:bg-amber-100 hover:text-neutral-900"
								>
									<Pencil aria-hidden className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
						)}
						{note.canDelete && !editing && (
							<Tooltip label={t("Delete note")}>
								<button
									type="button"
									aria-label={t("Delete note")}
									onClick={() => void remove()}
									className="rounded p-1 text-neutral-500 hover:bg-amber-100 hover:text-neutral-900"
								>
									<Trash2 aria-hidden className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
						)}
					</span>
				</div>
				{editing ? (
					<div className="mt-1 space-y-2">
						<Textarea
							aria-label={t("Edit note")}
							value={draft}
							maxLength={NOTE_MAX_LENGTH}
							autoFocus
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={editorKeys(
								() => void save(),
								() => setEditing(false),
							)}
							className="min-h-[72px] bg-white"
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={busy || !draft.trim()} onClick={() => void save()}>
								{t("Save")}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
								{t("Cancel")}
							</Button>
						</div>
					</div>
				) : (
					<p dir="auto" className="reading-font mt-0.5 whitespace-pre-wrap break-words text-neutral-800">
						<LinkifiedText text={note.body} />
					</p>
				)}
				<PinChip note={note} emails={emails} />
				{error && (
					<p role="alert" className="mt-1 text-xs text-red-700">
						{error}
					</p>
				)}
			</div>
		</li>
	);
}

function Composer({ controller }: { controller: ConversationNotesController }) {
	const t = useT();
	const [body, setBody] = useState("");
	const [aboutMessage, setAboutMessage] = useState(false);
	const [focused, setFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const pinId = useId();

	useEffect(() => {
		if (controller.composeRequest > 0) field.current?.focus();
	}, [controller.composeRequest]);

	const add = async () => {
		const text = body.trim();
		if (!text || busy) return;
		setBusy(true);
		const failed = await controller.add(text, aboutMessage);
		setBusy(false);
		setError(failed);
		if (!failed) {
			setBody("");
			setAboutMessage(false);
		}
	};
	// One line until someone writes; then room for a few lines and the options, kept while focus stays in the composer.
	const expanded = focused || body.length > 0;
	return (
		<div
			className="pt-2"
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<Textarea
				ref={field}
				aria-label={t("Write a note")}
				placeholder={t("Write a note…")}
				value={body}
				maxLength={NOTE_MAX_LENGTH}
				rows={expanded ? 3 : 1}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={editorKeys(() => void add())}
				className={expanded ? "min-h-[72px] bg-white" : "min-h-0 resize-none bg-white"}
			/>
			{expanded && (
				<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
					<label
						htmlFor={pinId}
						onMouseDown={(event) => event.preventDefault()}
						className="flex items-center gap-2 text-xs text-neutral-700"
					>
						<Checkbox id={pinId} checked={aboutMessage} onChange={(event) => setAboutMessage(event.target.checked)} />
						{t("About this email only")}
					</label>
					<Button
						size="sm"
						className="ms-auto"
						disabled={busy || !body.trim()}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => void add()}
					>
						{t("Add note")}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="mt-1 text-xs text-red-700">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * The notes band above the conversation (ported from upstream Mailflare #237): every note, oldest first, with its
 * author, time, the email it is about and the actions the viewer may take, then a composer for anyone who may write.
 * Notes are plain text, shown to everyone with access to the mailbox and never sent.
 */
export default function ConversationNotesBand({
	controller,
	emails,
}: {
	controller: ConversationNotesController;
	emails: readonly NoteEmail[];
}) {
	const t = useT();
	return (
		<div className="px-4 pb-5 sm:px-7">
			<section
				id={NOTES_BAND_ID}
				aria-label={t("Notes")}
				data-conversation-notes
				className="rounded-xl border border-amber-300 bg-amber-50/70 px-4 py-3 text-sm"
			>
				<div className="flex items-center gap-1.5 text-neutral-600">
					<StickyNote aria-hidden className="h-3.5 w-3.5" />
					<h2 className="flex-1 font-medium text-neutral-800">{t("Notes")}</h2>
					<Tooltip label={t("Hide notes")}>
						<button
							type="button"
							aria-label={t("Hide notes")}
							onClick={controller.close}
							className="rounded p-1 text-neutral-500 hover:bg-amber-100 hover:text-neutral-900"
						>
							<X aria-hidden className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
				</div>
				{controller.notes.length > 0 && (
					<ol className="mt-1 divide-y divide-amber-200/70">
						{controller.notes.map((note) => (
							<NoteItem key={note.id} note={note} emails={emails} controller={controller} />
						))}
					</ol>
				)}
				{controller.canWrite && <Composer controller={controller} />}
				<p className="pt-2 text-xs text-neutral-500">
					{t("Only people with access to this mailbox see notes. They are never sent.")}
					{!controller.canWrite &&
						` ${t("You have read-only access to this mailbox, so you can read notes but not add them.")}`}
				</p>
			</section>
		</div>
	);
}
