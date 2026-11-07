"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useT } from "@/lib/i18n/use-t";
import { paymentPath } from "./payment-row";
import type { PaymentForm, PaymentItem } from "./payments-types";
import { correctionBody, formFromPayment, STATUS_LABELS, TYPE_LABELS } from "./payments-utils";
import { announceWrite, financeWrite } from "./subscription-writes";

const TYPES = ["payment", "invoice", "refund", "credit"] as const;

function CorrectionForm({ item, onDone, onChanged }: { item: PaymentItem; onDone: () => void; onChanged: () => void }) {
	const t = useT();
	const [form, setForm] = useState<PaymentForm>(() => formFromPayment(item));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (patch: Partial<PaymentForm>) => setForm((current) => ({ ...current, ...patch }));

	async function save() {
		const planned = correctionBody(form, item);
		if ("error" in planned) {
			setError(t(planned.error));
			return;
		}
		if (Object.keys(planned.fields).length === 0) {
			onDone();
			return;
		}
		setSaving(true);
		setError(null);
		const result = await financeWrite(paymentPath(item.id), "PATCH", planned, t("Could not save the payment"));
		setSaving(false);
		if ("error" in result) {
			setError(result.error);
			return;
		}
		onDone();
		announceWrite(t("Payment corrected"), result.actionId, onChanged);
	}

	return (
		<form
			data-payment-form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<div className="space-y-1.5">
				<Label htmlFor="payment-vendor">{t("Vendor")}</Label>
				<Input
					id="payment-vendor"
					dir="auto"
					value={form.vendor}
					maxLength={80}
					onChange={(event) => set({ vendor: event.target.value })}
					required
				/>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="payment-amount">{t("Amount")}</Label>
					<Input
						id="payment-amount"
						dir="ltr"
						inputMode="decimal"
						value={form.amount}
						onChange={(event) => set({ amount: event.target.value })}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="payment-currency">{t("Currency")}</Label>
					<Input
						id="payment-currency"
						dir="ltr"
						value={form.currency}
						maxLength={3}
						onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
						required
					/>
				</div>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="payment-type">{t("Type")}</Label>
					<Select
						id="payment-type"
						containerClassName="flex h-9 text-sm"
						value={form.docType}
						onChange={(event) => set({ docType: event.target.value as PaymentForm["docType"] })}
					>
						{TYPES.map((type) => (
							<option key={type} value={type}>
								{t(TYPE_LABELS[type])}
							</option>
						))}
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="payment-date">{t("Date")}</Label>
					<Input
						id="payment-date"
						type="date"
						value={form.documentOn}
						onChange={(event) => set({ documentOn: event.target.value })}
						required
					/>
				</div>
			</div>
			{form.docType === "invoice" && (
				<div className="space-y-1.5">
					<Label htmlFor="payment-status">{t("Status")}</Label>
					<Select
						id="payment-status"
						containerClassName="flex h-9 text-sm"
						value={form.status}
						onChange={(event) => set({ status: event.target.value as PaymentForm["status"] })}
					>
						<option value="open">{t(STATUS_LABELS["open"])}</option>
						<option value="paid">{t(STATUS_LABELS["paid"])}</option>
					</Select>
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="outline" onClick={onDone}>
					{t("Cancel")}
				</Button>
				<Button type="submit" disabled={saving}>
					{saving ? t("Saving…") : t("Save changes")}
				</Button>
			</div>
		</form>
	);
}

/** "Correct…": the vendor, amount, currency, type, date and, for an invoice, whether it is paid; saved with Undo. */
export function PaymentDialog({
	item,
	onClose,
	onChanged,
}: {
	item: PaymentItem | null;
	onClose: () => void;
	onChanged: () => void;
}) {
	const t = useT();
	return (
		<Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent data-payment-dialog className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("Correct payment")}</DialogTitle>
					<DialogDescription>{t("Change what Money Watch read from this mail.")}</DialogDescription>
				</DialogHeader>
				{item && <CorrectionForm key={item.id} item={item} onDone={onClose} onChanged={onChanged} />}
			</DialogContent>
		</Dialog>
	);
}
