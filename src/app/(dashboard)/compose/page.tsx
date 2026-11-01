"use client";

import { ComposeForm } from "@/components/compose/compose-form";

export default function ComposePage() {
	// The card fills the screen between the title and the bottom edge, so its footer is never scrolled under the
	// notices, which stand in the extra room below it (the undo-send bar of a message sent from another composer).
	return (
		<div className="flex h-full flex-col overflow-auto p-8 pb-28">
			<div className="mb-6 shrink-0">
				<h1 className="text-2xl font-normal text-neutral-900">Compose</h1>
				<p className="mt-1 text-sm text-neutral-500">Write a new email. Drafts save automatically.</p>
			</div>
			<div className="min-h-[18rem] flex-1">
				<ComposeForm mode="page" />
			</div>
		</div>
	);
}
