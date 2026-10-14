"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";
import { undoAction } from "@/components/agent/suggestion-card-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";
import type { MessageSlotContext } from "../client-registry-types";
import type { DetectAnswer, DocumentForm, TrackForm } from "./dialog-types";
import { CYCLES, documentForm, linkHost, trackBody, trackForm } from "./dialog-utils";
import { DocumentFields } from "./document-fields";
import { errorOf, useDetectDraft } from "./use-detect-draft";

type OverlayProps = MessageSlotContext & { open: boolean; onOpenChange: (open: boolean) => void };

const localToday = () => new Date().toLocaleDateString("en-CA");

function TrackFields({ form, onChange }: { form: TrackForm; onChange: (form: TrackForm) => void }) {
	const set = (patch: Partial<TrackForm>) => onChange({ ...form, ...patch });
	return (
		<>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-vendor">Vendor</Label>
					<Input
						id="finance-track-vendor"
						value={form.vendor}
						onChange={(event) => set({ vendor: event.target.value })}
						maxLength={80}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-plan">Plan (optional)</Label>
					<Input
						id="finance-track-plan"
						value={form.plan}
						onChange={(event) => set({ plan: event.target.value })}
						maxLength={80}
					/>
				</div>
			</div>
			<div className="grid grid-cols-[1fr_6rem_1fr] gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-amount">Amount</Label>
					<Input
						id="finance-track-amount"
						inputMode="decimal"
						value={form.amount}
						onChange={(event) => set({ amount: event.target.value })}
						placeholder="17.99"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-currency">Currency</Label>
					<Input
						id="finance-track-currency"
						value={form.currency}
						onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
						maxLength={3}
						placeholder="EUR"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-cycle">Billed</Label>
					<Select
						id="finance-track-cycle"
						containerClassName="flex h-9 text-sm"
						value={form.cycle}
						onChange={(event) => set({ cycle: event.target.value })}
					>
						{CYCLES.map((cycle) => (
							<option key={cycle.value} value={cycle.value}>
								{cycle.label}
							</option>
						))}
					</Select>
				</div>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-renewal">Next renewal</Label>
					<Input
						id="finance-track-renewal"
						type="date"
						value={form.nextRenewalOn}
						onChange={(event) => set({ nextRenewalOn: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-trial">Trial ends (optional)</Label>
					<Input
						id="finance-track-trial"
						type="date"
						value={form.trialEndsOn}
						onChange={(event) => set({ trialEndsOn: event.target.value })}
					/>
				</div>
			</div>
			<div className="grid grid-cols-2 items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="finance-track-reminder">Remind days before</Label>
					<Input
						id="finance-track-reminder"
						type="number"
						min={0}
						max={30}
						value={form.reminderDays}
						onChange={(event) => set({ reminderDays: event.target.value })}
					/>
				</div>
				<label className="flex h-9 items-center gap-2 text-sm text-neutral-700">
					<Checkbox
						checked={form.calendarReminder}
						onChange={(event) => set({ calendarReminder: event.target.checked })}
					/>
					Add a calendar reminder
				</label>
			</div>
		</>
	);
}

function TrackMessageForm({ answer, onSaved }: { answer: DetectAnswer; onSaved: () => void }) {
	const { draft } = answer;
	const [form, setForm] = useState(() => trackForm(draft));
	const [record, setRecord] = useState(draft.document !== null);
	const [document, setDocument] = useState<DocumentForm>(() => documentForm(draft.document, localToday()));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		const built = trackBody(form, answer.messageId, record ? document : null);
		if ("error" in built) {
			setError(built.error);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch("/api/finance/subscriptions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(built.body),
			});
			if (!response.ok) {
				setError(await errorOf(response, "Could not track the subscription"));
				return;
			}
			const { actionId } = (await response.json()) as { actionId?: string };
			onSaved();
			if (actionId) showUndoToast("Tracking the subscription", () => undoAction(actionId));
		} catch {
			setError("Could not track the subscription");
		} finally {
			setSaving(false);
		}
	}

	return (
		<form
			data-finance-track-form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<TrackFields form={form} onChange={setForm} />
			<p data-finance-cancel-link className="flex items-center gap-1.5 text-xs text-neutral-600">
				<Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
				{draft.cancelLink
					? `Cancel link from the message: ${linkHost(draft.cancelLink.url)}`
					: "No cancel link in the message"}
			</p>
			<fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
				<label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
					<Checkbox checked={record} onChange={(event) => setRecord(event.target.checked)} />
					Record this message as
				</label>
				{record && (
					<DocumentFields
						idPrefix="finance-track-document"
						form={document}
						attachments={answer.attachments}
						onChange={setDocument}
					/>
				)}
			</fieldset>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<Button type="submit" disabled={saving || !form.vendor.trim()}>
				{saving ? "Saving…" : "Track subscription"}
			</Button>
		</form>
	);
}

/** "Track as subscription": the detector's reading of the message, editable, stored only on save. */
export function TrackMessageDialog({ messageId, open, onOpenChange }: OverlayProps) {
	const { loading, error, answer } = useDetectDraft(messageId, open);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-finance-track-dialog className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Track as subscription</DialogTitle>
				</DialogHeader>
				{loading && <p className="text-sm text-neutral-600">Reading the message…</p>}
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				{answer && <TrackMessageForm key={answer.messageId} answer={answer} onSaved={() => onOpenChange(false)} />}
			</DialogContent>
		</Dialog>
	);
}
