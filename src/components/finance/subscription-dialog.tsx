"use client";

import { useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import type { TrackForm } from "./dialog-types";
import { trackForm } from "./dialog-utils";
import { SubscriptionFields } from "./subscription-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { announceWrite, financeWrite, subscriptionPath } from "./subscription-writes";
import type { SubscriptionItem } from "./subscriptions-types";
import { addBody, editChanges, formFromItem } from "./subscriptions-utils";

type DialogProps = {
	/** The row to edit; null adds a new one. */
	item: SubscriptionItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChanged: () => void;
};

/** Mailboxes the viewer manages, which are the ones an audit row may name. */
function useManagedMailboxes() {
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const managed = mailboxes.filter((mailbox) => !mailbox.permission || mailbox.permission === "full_access");
	const preferred = managed.find((mailbox) => mailbox.id === selectedMailbox?.id) ?? managed[0] ?? null;
	return { managed, preferredId: preferred?.id ?? "" };
}

function SubscriptionForm({
	item,
	onDone,
	onChanged,
}: {
	item: SubscriptionItem | null;
	onDone: () => void;
	onChanged: () => void;
}) {
	const [form, setForm] = useState<TrackForm>(() => (item ? formFromItem(item) : trackForm(null)));
	const { managed, preferredId } = useManagedMailboxes();
	const [mailboxId, setMailboxId] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chosenMailbox = mailboxId || preferredId;

	async function save() {
		const planned = item ? editChanges(form, item) : addBody(form, chosenMailbox || null);
		if ("error" in planned) {
			setError(planned.error);
			return;
		}
		if ("fields" in planned && Object.keys(planned.fields).length === 0) {
			onDone();
			return;
		}
		setSaving(true);
		setError(null);
		const result = item
			? await financeWrite(subscriptionPath(item.id), "PATCH", planned, "Could not save the subscription")
			: await financeWrite(
					"/api/finance/subscriptions",
					"POST",
					"body" in planned ? planned.body : planned,
					"Could not add the subscription",
				);
		setSaving(false);
		if ("error" in result) {
			setError(result.error);
			return;
		}
		onDone();
		announceWrite(item ? "Subscription changed" : "Subscription added", result.actionId, onChanged);
	}

	return (
		<form
			data-finance-subscription-form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<SubscriptionFields
				idPrefix={item ? "finance-edit" : "finance-add"}
				form={form}
				onChange={setForm}
				reminder={!item}
			/>
			{!item && (
				<div className="space-y-1.5">
					<Label htmlFor="finance-add-mailbox">Mailbox</Label>
					<Select
						id="finance-add-mailbox"
						containerClassName="flex h-9 text-sm"
						value={chosenMailbox}
						onChange={(event) => setMailboxId(event.target.value)}
					>
						{managed.map((mailbox) => (
							<option key={mailbox.id} value={mailbox.id}>
								{mailbox.displayName || `${mailbox.localPart}@${mailbox.hostname}`}
							</option>
						))}
					</Select>
					<p className="text-xs text-neutral-500">Activity lists the change under this mailbox.</p>
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" disabled={saving || !form.vendor.trim()}>
					{saving ? "Saving…" : item ? "Save changes" : "Add subscription"}
				</Button>
			</div>
		</form>
	);
}

/** "Add subscription" and "Edit": the subscription's fields; every save is an audited write with Undo. */
export function SubscriptionDialog({ item, open, onOpenChange, onChanged }: DialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-finance-subscription-dialog className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{item ? `Edit ${item.vendor}` : "Add subscription"}</DialogTitle>
					<DialogDescription>
						{item ? "Change what Money Watch knows about this subscription." : "Track a subscription by hand."}
					</DialogDescription>
				</DialogHeader>
				{open && (
					<SubscriptionForm
						key={item?.id ?? "new"}
						item={item}
						onDone={() => onOpenChange(false)}
						onChanged={onChanged}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
