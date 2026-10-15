"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { TrackForm } from "./dialog-types";
import { CYCLES } from "./dialog-utils";

type FieldsProps = {
	form: TrackForm;
	onChange: (form: TrackForm) => void;
	/** Prefix of the input ids, so two dialogs never share one. */
	idPrefix?: string;
	/** The reminder days and calendar switch; an edit changes them from the row menu instead. */
	reminder?: boolean;
};

/** The subscription fields of the track, add and edit dialogs. */
export function SubscriptionFields({ form, onChange, idPrefix = "finance-track", reminder = true }: FieldsProps) {
	const set = (patch: Partial<TrackForm>) => onChange({ ...form, ...patch });
	const id = (name: string) => `${idPrefix}-${name}`;
	return (
		<>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor={id("vendor")}>Vendor</Label>
					<Input
						id={id("vendor")}
						value={form.vendor}
						onChange={(event) => set({ vendor: event.target.value })}
						maxLength={80}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={id("plan")}>Plan (optional)</Label>
					<Input
						id={id("plan")}
						value={form.plan}
						onChange={(event) => set({ plan: event.target.value })}
						maxLength={80}
					/>
				</div>
			</div>
			<div className="grid grid-cols-[1fr_6rem_1fr] gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={id("amount")}>Amount</Label>
					<Input
						id={id("amount")}
						inputMode="decimal"
						value={form.amount}
						onChange={(event) => set({ amount: event.target.value })}
						placeholder="17.99"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={id("currency")}>Currency</Label>
					<Input
						id={id("currency")}
						value={form.currency}
						onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
						maxLength={3}
						placeholder="EUR"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={id("cycle")}>Billed</Label>
					<Select
						id={id("cycle")}
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
					<Label htmlFor={id("renewal")}>Next renewal</Label>
					<Input
						id={id("renewal")}
						type="date"
						value={form.nextRenewalOn}
						onChange={(event) => set({ nextRenewalOn: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={id("trial")}>Trial ends (optional)</Label>
					<Input
						id={id("trial")}
						type="date"
						value={form.trialEndsOn}
						onChange={(event) => set({ trialEndsOn: event.target.value })}
					/>
				</div>
			</div>
			{reminder && (
				<div className="grid grid-cols-2 items-end gap-3">
					<div className="space-y-1.5">
						<Label htmlFor={id("reminder")}>Remind days before</Label>
						<Input
							id={id("reminder")}
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
			)}
		</>
	);
}
