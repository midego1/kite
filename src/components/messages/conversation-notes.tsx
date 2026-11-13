"use client";

import { lazy, Suspense } from "react";
import { StickyNote } from "lucide-react";
import type { ReaderToolbarNotes } from "@/components/message-actions/types";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n/use-t";
import type { ConversationNotesController, NoteEmail } from "./conversation-notes-types";
import { NOTES_BAND_ID } from "./conversation-notes-utils";

/** The band's list, editor and actions load only once a conversation has notes or someone writes one. */
const ConversationNotesBand = lazy(() => import("./conversation-notes-band"));

/** Opens the band: straight into the composer when there is nothing to read yet and the viewer may write. */
function openNotes(controller: ConversationNotesController) {
	if (controller.notes.length === 0 && controller.canWrite) controller.compose();
	else if (!controller.open) controller.toggle();
}

function NotesButton({ controller, label }: { controller: ConversationNotesController; label: string }) {
	const t = useT();
	const { notes, open } = controller;
	return (
		<Tooltip label={open ? t("Hide notes") : label}>
			<Button
				variant="ghost"
				size="roundedSM"
				aria-label={label}
				aria-expanded={open}
				aria-controls={open ? NOTES_BAND_ID : undefined}
				data-testid="conversation-notes-button"
				onClick={() => (open ? controller.close() : openNotes(controller))}
				className="gap-1"
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

/**
 * The reader toolbar's Notes action: a button with the conversation's note count that shows and hides the notes
 * band, which moves into "More actions" when the row has no room. None before the database update, or for
 * read-only access to a conversation without notes, where there is nothing to show and nothing to do.
 */
export function useReaderNotesAction(controller: ConversationNotesController): ReaderToolbarNotes | undefined {
	const t = useT();
	const { notes, loaded, unavailable, canWrite } = controller;
	if (!loaded || unavailable || (!canWrite && notes.length === 0)) return undefined;
	const label = notes.length
		? t("{count, plural, one {# note} other {# notes}}", { count: notes.length })
		: t("Add a note");
	return {
		label,
		button: <NotesButton controller={controller} label={label} />,
		onOpen: () => openNotes(controller),
	};
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
