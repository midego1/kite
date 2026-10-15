"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { DocumentForm, DocumentType, DraftAttachment } from "@/components/finance/dialog-types";
import { DOCUMENT_TYPES } from "@/components/finance/dialog-utils";

/** Type, amount, currency, date, optional period and attachment of one money document. */
export function DocumentFields({
	idPrefix,
	form,
	attachments,
	onChange,
}: {
	idPrefix: string;
	form: DocumentForm;
	attachments: DraftAttachment[];
	onChange: (form: DocumentForm) => void;
}) {
	const set = (patch: Partial<DocumentForm>) => onChange({ ...form, ...patch });
	const field = (name: string) => `${idPrefix}-${name}`;
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={field("type")}>Document</Label>
					<Select
						id={field("type")}
						containerClassName="flex h-9 text-sm"
						value={form.docType}
						onChange={(event) => set({ docType: event.target.value as DocumentType })}
					>
						{DOCUMENT_TYPES.map((type) => (
							<option key={type.value} value={type.value}>
								{type.label}
							</option>
						))}
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={field("date")}>Date</Label>
					<Input
						id={field("date")}
						type="date"
						value={form.documentOn}
						onChange={(event) => set({ documentOn: event.target.value })}
						required
					/>
				</div>
			</div>
			<div className="grid grid-cols-[1fr_6rem] gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={field("amount")}>Amount</Label>
					<Input
						id={field("amount")}
						inputMode="decimal"
						value={form.amount}
						onChange={(event) => set({ amount: event.target.value })}
						placeholder="17.99"
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={field("currency")}>Currency</Label>
					<Input
						id={field("currency")}
						value={form.currency}
						onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
						maxLength={3}
						placeholder="EUR"
						required
					/>
				</div>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={field("period-start")}>Period from (optional)</Label>
					<Input
						id={field("period-start")}
						type="date"
						value={form.periodStartOn}
						onChange={(event) => set({ periodStartOn: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={field("period-end")}>Period to</Label>
					<Input
						id={field("period-end")}
						type="date"
						value={form.periodEndOn}
						onChange={(event) => set({ periodEndOn: event.target.value })}
					/>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={field("attachment")}>Attachment</Label>
				<Select
					id={field("attachment")}
					containerClassName="flex h-9 text-sm"
					value={form.attachmentId}
					onChange={(event) => set({ attachmentId: event.target.value })}
				>
					<option value="">None</option>
					{attachments.map((attachment) => (
						<option key={attachment.id} value={attachment.id}>
							{attachment.filename}
						</option>
					))}
				</Select>
			</div>
		</div>
	);
}
