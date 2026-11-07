"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
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
	proposalDetails,
	proposalFields,
	showsEstimatedRenewal,
	withEdit,
	type TrackProposalDetails,
	type TrackProposalFields,
} from "./track-proposal-utils";
import type { MessageKey } from "@/lib/i18n/i18n-types";

type FieldKey = keyof Omit<TrackProposalFields, "mode" | "emailId" | "attachmentId" | "subscriptionId">;

const INPUT = "h-8 text-xs";
const SELECT = "flex h-8 text-xs";

/** One field; `data-card-field` names the input key it shows, which the card-equals-save test reads. */
function Field({
	id,
	name,
	label,
	note,
	children,
}: {
	id: string;
	name: FieldKey;
	label: string;
	note?: string | null;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0 space-y-1" data-card-field={name}>
			<label htmlFor={id} className="block font-medium text-neutral-700">
				{label}
				{note && <span className="ms-1 font-normal text-neutral-500">· {note}</span>}
			</label>
			{children}
		</div>
	);
}

type Controls = {
	fieldId: (key: FieldKey) => string;
	value: (key: FieldKey) => string;
	set: (key: FieldKey, value: string) => void;
	note: (key: FieldKey) => string | null;
	disabled: boolean;
};

function TextField({
	controls,
	name,
	label,
	note,
	...input
}: {
	controls: Controls;
	name: FieldKey;
	label: string;
	note?: string | null;
} & Pick<ComponentProps<typeof Input>, "type" | "inputMode" | "dir" | "maxLength" | "placeholder">) {
	return (
		<Field id={controls.fieldId(name)} name={name} label={label} note={note === undefined ? controls.note(name) : note}>
			<Input
				id={controls.fieldId(name)}
				className={INPUT}
				value={controls.value(name)}
				disabled={controls.disabled}
				onChange={(event) =>
					controls.set(name, name === "currency" ? event.target.value.toUpperCase() : event.target.value)
				}
				{...input}
			/>
		</Field>
	);
}

function ChoiceField({
	controls,
	name,
	label,
	none,
	options,
}: {
	controls: Controls;
	name: FieldKey;
	label: string;
	none: string;
	options: { value: string; label: MessageKey }[];
}) {
	const t = useT();
	return (
		<Field id={controls.fieldId(name)} name={name} label={label} note={controls.note(name)}>
			<Select
				id={controls.fieldId(name)}
				containerClassName={SELECT}
				value={controls.value(name)}
				disabled={controls.disabled}
				onChange={(event) => controls.set(name, event.target.value)}
			>
				<option value="">{none}</option>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{t(option.label)}
					</option>
				))}
			</Select>
		</Field>
	);
}

function Money({ controls }: { controls: Controls }) {
	const t = useT();
	return (
		<div className="grid grid-cols-[1fr_5rem] gap-2">
			<TextField
				controls={controls}
				name="amount"
				label={t("Amount")}
				inputMode="decimal"
				dir="ltr"
				placeholder="17.99"
			/>
			<TextField controls={controls} name="currency" label={t("Currency")} dir="ltr" maxLength={3} placeholder="EUR" />
		</div>
	);
}

/** The fields of a new subscription, and the email as its first document when a type is chosen. */
function TrackFields({
	controls,
	fields,
	details,
	edits,
}: {
	controls: Controls;
	fields: TrackProposalFields;
	details: TrackProposalDetails;
	edits: Record<string, unknown>;
}) {
	const t = useT();
	const estimated = showsEstimatedRenewal(fields, details, edits);
	return (
		<>
			<TextField controls={controls} name="vendor" label={t("Service")} dir="auto" maxLength={80} />
			<TextField controls={controls} name="plan" label={t("Plan")} dir="auto" maxLength={80} />
			<Money controls={controls} />
			<div className="grid grid-cols-2 gap-2">
				<ChoiceField
					controls={controls}
					name="cycle"
					label={t("Billing period")}
					none={t("Not stated")}
					options={CYCLE_OPTIONS}
				/>
				<TextField
					controls={controls}
					name="nextRenewalOn"
					label={t("Next renewal")}
					type="date"
					note={estimated ? t("estimated") : undefined}
				/>
			</div>
			{fields.emailId && (
				<ChoiceField
					controls={controls}
					name="docType"
					label={t("Record this email as")}
					none={t("Do not record it")}
					options={DOC_TYPE_OPTIONS}
				/>
			)}
			{fields.emailId && fields.docType && (
				<TextField controls={controls} name="documentOn" label={t("Document date")} type="date" />
			)}
		</>
	);
}

/**
 * The `track_subscription` approval card: the fields Kite read from the email (and only where it read nothing, what
 * the assistant supplied, marked so), all editable. A field nobody stated stays empty and the approve button asks for
 * what is required, so nothing is guessed. In `attach` mode the service is already tracked and the card adds the
 * email to it as a document instead. Every value the approval saves is drawn here (`tests/finance-chat-track-card`).
 */
function TrackProposalBody({ input, details: rawDetails, edits, onEditsChange, disabled }: ProposalCardContext) {
	const t = useT();
	const id = useId();
	const fields = proposalFields({ ...input, ...edits });
	const details = proposalDetails(rawDetails);
	const controls: Controls = {
		fieldId: (key) => `${id}-${key}`,
		value: (key) => fields[key] ?? "",
		set: (key, value) => onEditsChange(withEdit(edits, key, value, details.renewalEstimated)),
		note: (key) => (details.assisted.includes(key) && !Object.hasOwn(edits, key) ? t("from the assistant") : null),
		disabled,
	};
	const attach = fields.mode === "attach";
	return (
		<div
			data-finance-track-proposal={fields.mode}
			className="space-y-3 rounded-xl border border-blue-100 bg-white p-3 shadow-sm"
		>
			<div className="flex items-start gap-2">
				<WalletCards size={16} className="mt-0.5 shrink-0 text-blue-800" aria-hidden="true" />
				<div className="min-w-0">
					<p className="font-semibold text-neutral-900" {...(attach ? { "data-card-field": "subscriptionId" } : {})}>
						{attach ? (
							<>
								{t("Already tracked:")} <bdi>{details.existing?.vendor ?? fields.vendor}</bdi>
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
			{fields.emailId && (
				<p data-card-field="emailId" className="break-words text-neutral-600">
					{t("From the email:")}{" "}
					<bdi className="font-medium text-neutral-800">{details.email?.subject || t("(no subject)")}</bdi>
					{details.email?.from && (
						<span className="text-neutral-500">
							{" "}
							· <bdi>{details.email.from}</bdi>
						</span>
					)}
				</p>
			)}
			{attach ? (
				<>
					<ChoiceField
						controls={controls}
						name="docType"
						label={t("This email is")}
						none={t("Choose…")}
						options={DOC_TYPE_OPTIONS}
					/>
					<Money controls={controls} />
					<TextField controls={controls} name="documentOn" label={t("Date")} type="date" />
				</>
			) : (
				<TrackFields controls={controls} fields={fields} details={details} edits={edits} />
			)}
			{fields.attachmentId && fields.docType && (
				<p data-card-field="attachmentId" className="break-words text-neutral-500">
					{t("Document:")} <bdi>{details.attachmentName ?? t("an attachment of the email")}</bdi>
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
