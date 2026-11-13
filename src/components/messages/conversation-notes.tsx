"use client";

import { lazy, Suspense } from "react";
import { StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n/use-t";
import type { ConversationNotesController, NoteEmail } from "./conversation-notes-types";
import { NOTES_BAND_ID } from "./conversation-notes-utils";

/** The band's list, editor and actions load only once a conversation has notes or someone writes one. */
const ConversationNotesBand = lazy(() => import("./conversation-notes-band"));

/** The reader toolbar's Notes button: the count of the conversation's notes; it shows and hides the notes band. */
export function ConversationNotesButton({ controller }: { controller: ConversationNotesController }) {
	const t = useT();
	const { notes, loaded, unavailable, open, canWrite } = controller;
	// Nothing to show and nothing to do: before the database update, or read-only access to a conversation without notes.
	if (!loaded || unavailable || (!canWrite && notes.length === 0)) return null;
	const label = notes.length
		? t("{count, plural, one {# note} other {# notes}}", { count: notes.length })
		: t("Add a note");
	return (
		<Tooltip label={open ? t("Hide notes") : label}>
			<Button
				variant="ghost"
				size="sm"
				aria-label={label}
				aria-expanded={open}
				aria-controls={open ? NOTES_BAND_ID : undefined}
				data-testid="conversation-notes-button"
				onClick={() => (open || notes.length > 0 || !canWrite ? controller.toggle() : controller.compose())}
				className="gap-1.5 pointer-coarse:h-11 text-neutral-700"
			>
				<StickyNote aria-hidden className="h-4 w-4" />
				{notes.length > 0 && (
					<span className="min-w-4 rounded-full bg-amber-100 px-1 text-xs font-medium tabular-nums text-amber-900">
						{notes.length}
					</span>
				)}
			</Button>
		</Tooltip>
	);
}

/** The notes band above the conversation, when it is open. */
export function ConversationNotes({
	controller,
	emails,
}: {
	controller: ConversationNotesController;
	emails: readonly NoteEmail[];
}) {
	if (!controller.open || controller.unavailable) return null;
	return (
		<Suspense fallback={null}>
			<ConversationNotesBand controller={controller} emails={emails} />
		</Suspense>
	);
}
