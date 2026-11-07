"use client";

import { useId, type ReactNode } from "react";
import { WalletCards } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useT } from "@/lib/i18n/use-t";
import type { ModuleProposalCard, ProposalCardContext } from "../client-registry-types";
import {
	CYCLE_OPTIONS,
	DOC_TYPE_OPTIONS,
	approveState,
	approvedText,
	editValue,
	proposalDetails,
	proposalFields,
	type TrackProposalFields,
} from "./track-proposal-utils";

type FieldKey = keyof Omit<TrackProposalFields, "mode" | "emailId">;

const INPUT = "h-8 text-xs";
const SELECT = "flex h-8 text-xs";

function Field({
	id,
	label,
	note,
	children,
}: {
	id: string;
	label: string;
	note?: string | null;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0 space-y-1">
			<label htmlFor={id} className="block font-medium text-neutral-700">
				{label}
				{note && <span className="ms-1 font-normal text-neutral-500">· {note}</span>}
			</label>
			{children}
		</div>
	);
}

/**
 * The `track_subscription` approval card: the fields Kite read from the email (and only where it read nothing, what
 * the assistant supplied, marked so), all editable. A field nobody stated stays empty and the approve button asks for
 * what is required, so nothing is guessed. In `attach` mode the service is already tracked and the card adds the
 * email to it as a document instead.
 */
function TrackProposalBody({ input, details: rawDetails, edits, onEditsChange, disabled }: ProposalCardContext) {
	const t = useT();
	const id = useId();
	const fields = proposalFields({ ...input, ...edits });
	const details = proposalDetails(rawDetails);
	const edited = (key: FieldKey) => Object.hasOwn(edits, key);
	const note = (key: FieldKey) => (details.assisted.includes(key) && !edited(key) ? t("from the assistant") : null);
	const set = (key: FieldKey, value: string) => onEditsChange({ ...edits, [key]: editValue(value) });
	const value = (key: FieldKey) => fields[key] ?? "";
	const fieldId = (key: FieldKey) => `${id}-${key}`;
	const attach = fields.mode === "attach";
	const money = (
		<div className="grid grid-cols-[1fr_5rem] gap-2">
			<Field id={fieldId("amount")} label={t("Amount")} note={note("amount")}>
				<Input
					id={fieldId("amount")}
					className={INPUT}
					inputMode="decimal"
					dir="ltr"
					value={value("amount")}
					placeholder="17.99"
					disabled={disabled}
					onChange={(event) => set("amount", event.target.value)}
				/>
			</Field>
			<Field id={fieldId("currency")} label={t("Currency")} note={note("currency")}>
				<Input
					id={fieldId("currency")}
					className={INPUT}
					dir="ltr"
					maxLength={3}
					value={value("currency")}
					placeholder="EUR"
					disabled={disabled}
					onChange={(event) => set("currency", event.target.value.toUpperCase())}
				/>
			</Field>
		</div>
	);
	const docType = (label: string, none: string | null) => (
		<Field id={fieldId("docType")} label={label}>
			<Select
				id={fieldId("docType")}
				containerClassName={SELECT}
				value={value("docType")}
				disabled={disabled}
				onChange={(event) => set("docType", event.target.value)}
			>
				<option value="">{none ?? t("Choose…")}</option>
				{DOC_TYPE_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{t(option.label)}
					</option>
				))}
			</Select>
		</Field>
	);
	return (
		<div
			data-finance-track-proposal={fields.mode}
			className="space-y-3 rounded-xl border border-blue-100 bg-white p-3 shadow-sm"
		>
			<div className="flex items-start gap-2">
				<WalletCards size={16} className="mt-0.5 shrink-0 text-blue-800" aria-hidden="true" />
				<div className="min-w-0">
					<p className="font-semibold text-neutral-900">
						{attach && details.existing ? (
							<>
								{t("Already tracked:")} <bdi>{details.existing.vendor}</bdi>
							</>
						) : (
							t("Track this subscription")
						)}
					</p>
					<p className="text-neutral-500">
						{attach
							? t("Kite adds this email to it instead of tracking it twice.")
							: t("Check the fields. Nothing is saved until you approve.")}
					</p>
				</div>
			</div>
			{attach ? (
				<>
					{docType(t("This email is"), null)}
					{money}
					<Field id={fieldId("documentOn")} label={t("Date")}>
						<Input
							id={fieldId("documentOn")}
							type="date"
							className={INPUT}
							value={value("documentOn")}
							disabled={disabled}
							onChange={(event) => set("documentOn", event.target.value)}
						/>
					</Field>
				</>
			) : (
				<>
					<Field id={fieldId("vendor")} label={t("Service")} note={note("vendor")}>
						<Input
							id={fieldId("vendor")}
							className={INPUT}
							dir="auto"
							maxLength={80}
							value={value("vendor")}
							disabled={disabled}
							onChange={(event) => set("vendor", event.target.value)}
						/>
					</Field>
					{money}
					<div className="grid grid-cols-2 gap-2">
						<Field id={fieldId("cycle")} label={t("Billing period")} note={note("cycle")}>
							<Select
								id={fieldId("cycle")}
								containerClassName={SELECT}
								value={value("cycle")}
								disabled={disabled}
								onChange={(event) => set("cycle", event.target.value)}
							>
								<option value="">{t("Not stated")}</option>
								{CYCLE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{t(option.label)}
									</option>
								))}
							</Select>
						</Field>
						<Field
							id={fieldId("nextRenewalOn")}
							label={t("Next renewal")}
							note={
								details.renewalEstimated && !edited("nextRenewalOn") && fields.nextRenewalOn
									? t("estimated")
									: note("nextRenewalOn")
							}
						>
							<Input
								id={fieldId("nextRenewalOn")}
								type="date"
								className={INPUT}
								value={value("nextRenewalOn")}
								disabled={disabled}
								onChange={(event) => set("nextRenewalOn", event.target.value)}
							/>
						</Field>
					</div>
					{fields.emailId && docType(t("Record this email as"), t("Do not record it"))}
				</>
			)}
			{details.attachmentName && fields.docType && (
				<p className="break-words text-neutral-500">
					{t("Document:")} <bdi>{details.attachmentName}</bdi>
				</p>
			)}
		</div>
	);
}

export const trackProposalCard: ModuleProposalCard = {
	Body: TrackProposalBody,
	approve: (input) => approveState(proposalFields(input)),
	approvedText: (input) => approvedText(proposalFields(input)),
};
