"use client";

import { useEffect, useState } from "react";
import { undoAction } from "@/components/agent/suggestion-card-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";
import type { MessageSlotContext } from "../client-registry-types";
import type { DetectAnswer, DocumentForm, TrackedOption } from "./dialog-types";
import { documentBody, documentForm } from "./dialog-utils";
import { DocumentFields } from "./document-fields";
import { errorOf, useDetectDraft } from "./use-detect-draft";

type OverlayProps = MessageSlotContext & { open: boolean; onOpenChange: (open: boolean) => void };

const localToday = () => new Date().toLocaleDateString("en-CA");

/** The user's tracked subscriptions, loaded while the dialog is open. */
function useTracked(open: boolean): TrackedOption[] | null {
	const [tracked, setTracked] = useState<TrackedOption[] | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		authFetch("/api/finance/subscriptions")
			.then((response) => (response.ok ? (response.json() as Promise<{ subscriptions: TrackedOption[] }>) : null))
			.then((data) => {
				if (live) setTracked(data?.subscriptions ?? []);
			})
			.catch(() => {
				if (live) setTracked([]);
			});
		return () => {
			live = false;
		};
	}, [open]);
	return open ? tracked : null;
}

const optionLabel = (option: TrackedOption) =>
	[option.vendor, option.plan, option.status === "active" ? null : option.status].filter(Boolean).join(" · ");

function AddDocumentForm({
	answer,
	tracked,
	onSaved,
}: {
	answer: DetectAnswer;
	tracked: TrackedOption[];
	onSaved: () => void;
}) {
	const matched = tracked.find((option) => option.id === answer.draft.subscriptionId);
	const [subscriptionId, setSubscriptionId] = useState(matched?.id ?? tracked[0]?.id ?? "");
	const [form, setForm] = useState<DocumentForm>(() => documentForm(answer.draft.document, localToday()));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		const built = documentBody(form);
		if ("error" in built) {
			setError(built.error);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch(`/api/finance/subscriptions/${encodeURIComponent(subscriptionId)}/documents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...built.body, messageId: answer.messageId }),
			});
			if (!response.ok) {
				setError(await errorOf(response, "Could not record the document"));
				return;
			}
			const { actionId } = (await response.json()) as { actionId?: string };
			onSaved();
			if (actionId) showUndoToast("Document recorded", () => undoAction(actionId));
		} catch {
			setError("Could not record the document");
		} finally {
			setSaving(false);
		}
	}

	if (tracked.length === 0)
		return <p className="text-sm text-neutral-600">You are not tracking any subscriptions yet.</p>;

	return (
		<form
			data-finance-document-form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<div className="space-y-1.5">
				<Label htmlFor="finance-document-subscription">Subscription</Label>
				<Select
					id="finance-document-subscription"
					containerClassName="flex h-9 text-sm"
					value={subscriptionId}
					onChange={(event) => setSubscriptionId(event.target.value)}
				>
					{tracked.map((option) => (
						<option key={option.id} value={option.id}>
							{optionLabel(option)}
						</option>
					))}
				</Select>
			</div>
			<DocumentFields idPrefix="finance-document" form={form} attachments={answer.attachments} onChange={setForm} />
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<Button type="submit" disabled={saving || !subscriptionId}>
				{saving ? "Saving…" : "Record document"}
			</Button>
		</form>
	);
}

/** "Add to a tracked subscription": records the message as an invoice, payment, credit note or refund. */
export function AddDocumentDialog({ messageId, open, onOpenChange }: OverlayProps) {
	const { loading, error, answer } = useDetectDraft(messageId, open);
	const tracked = useTracked(open);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-finance-document-dialog className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Add to a tracked subscription</DialogTitle>
				</DialogHeader>
				{(loading || (answer && !tracked)) && <p className="text-sm text-neutral-600">Reading the message…</p>}
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				{answer && tracked && (
					<AddDocumentForm
						key={answer.messageId}
						answer={answer}
						tracked={tracked}
						onSaved={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
