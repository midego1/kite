"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { TwoWaySettings, TwoWayView } from "@/lib/external-accounts/two-way-types";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { fetchTwoWay, offeredMoves, saveTwoWay, supportNote, twoWaySummary } from "./account-two-way-utils";

function Setting({
	label,
	value,
	disabled,
	options,
	onChange,
}: {
	label: string;
	value: string;
	disabled: boolean;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-700">
			<span>{label}</span>
			<Select
				aria-label={label}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				containerClassName="min-w-48"
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		</label>
	);
}

const NOTHING = { value: "nothing", label: "Nothing" };
const ON_OFF = [
	{ value: "off", label: "Off" },
	{ value: "on", label: "On" },
];

function TwoWayFields({
	view,
	usable,
	saving,
	onSave,
}: {
	view: TwoWayView;
	usable: boolean;
	saving: boolean;
	onSave: (settings: TwoWaySettings) => void;
}) {
	const { settings, support } = view;
	const offered = offeredMoves(support);
	const disabled = !usable || saving;
	const note = supportNote(support);
	const set = (patch: Partial<TwoWaySettings>) => onSave({ ...settings, ...patch });
	return (
		<div className="space-y-3 rounded-lg border border-neutral-200 p-3">
			<fieldset className="space-y-2">
				<legend className="text-xs font-medium text-neutral-800">When you act in Kite</legend>
				<Setting
					label="Delete in Kite"
					value={settings.kiteDelete}
					disabled={disabled}
					options={[NOTHING, ...(offered.trash ? [{ value: "trash", label: "Move to the provider's Trash" }] : [])]}
					onChange={(value) => set({ kiteDelete: value as TwoWaySettings["kiteDelete"] })}
				/>
				<Setting
					label="Archive in Kite"
					value={settings.kiteArchive}
					disabled={disabled}
					options={[NOTHING, ...(offered.archive ? [{ value: "archive", label: "Archive at the provider" }] : [])]}
					onChange={(value) => set({ kiteArchive: value as TwoWaySettings["kiteArchive"] })}
				/>
				<Setting
					label="Move to Spam in Kite"
					value={settings.kiteSpam}
					disabled={disabled}
					options={[NOTHING, ...(offered.spam ? [{ value: "spam", label: "Move to the provider's Spam" }] : [])]}
					onChange={(value) => set({ kiteSpam: value as TwoWaySettings["kiteSpam"] })}
				/>
				<Setting
					label="Read, unread and star in Kite"
					value={settings.kiteFlags ? "on" : "off"}
					disabled={disabled}
					options={ON_OFF}
					onChange={(value) => set({ kiteFlags: value === "on" })}
				/>
			</fieldset>
			<fieldset className="space-y-2">
				<legend className="text-xs font-medium text-neutral-800">When something changes at the provider</legend>
				<Setting
					label="Deleted or moved out of the Inbox"
					value={settings.providerGone}
					disabled={disabled}
					options={[NOTHING, { value: "trash", label: "Move to Kite's Trash" }]}
					onChange={(value) => set({ providerGone: value as TwoWaySettings["providerGone"] })}
				/>
				<Setting
					label="Read, unread and star at the provider"
					value={settings.providerFlags ? "on" : "off"}
					disabled={disabled}
					options={ON_OFF}
					onChange={(value) => set({ providerFlags: value === "on" })}
				/>
			</fieldset>
			<p className="text-xs text-neutral-500">
				Only mail Kite fetched from this account, and only what you do from now on. Mail Kite files by itself stays put
				at the provider. Kite compares the newest {view.windowSize.toLocaleString("en")} Inbox messages at each check,
				and never deletes anything permanently.
			</p>
			{note && <p className="text-xs text-neutral-500">{note}</p>}
			{view.pending > 0 && (
				<p className="text-xs text-neutral-600" data-two-way-pending>
					{view.pending === 1 ? "1 change is" : `${view.pending} changes are`} waiting to reach the provider.
				</p>
			)}
			{view.problems.length > 0 && (
				<div className="space-y-1" data-two-way-problems>
					<p className="text-xs font-medium text-neutral-800">Recent problems</p>
					<ul className="space-y-0.5 text-xs text-neutral-500">
						{view.problems.map((problem) => (
							<li key={`${problem.at}${problem.message}`}>{problem.message}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/**
 * Two-way sync on an account row (spec §6.8), everything off by default. The settings and what the server supports are
 * read as soon as the row shows, so its state is visible open or closed; the server is asked what it supports at most
 * once a day, and a failure stays silent until the row is opened.
 */
export function AccountTwoWay({ account, usable }: { account: ExternalAccountView; usable: boolean }) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<TwoWayView | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		fetchTwoWay(account.id)
			.then((next) => {
				if (current) {
					setView(next);
					setError(null);
				}
			})
			.catch((cause: unknown) => {
				if (current && open) setError(cause instanceof Error ? cause.message : "Could not load the two-way settings");
			});
		return () => {
			current = false;
		};
	}, [open, account.id]);

	async function save(settings: TwoWaySettings) {
		setSaving(true);
		setError(null);
		try {
			setView(await saveTwoWay(account.id, settings));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the two-way settings");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-1 pt-1" data-account-two-way={account.address}>
			<button
				type="button"
				className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md text-start text-xs hover:text-neutral-900"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<ChevronRight
					aria-hidden="true"
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform rtl:-scale-x-100",
						open && "rotate-90 rtl:-rotate-90",
					)}
				/>
				<span className="font-medium text-neutral-700">Two-way sync: choose what stays in step</span>
				{view && <span className="ms-auto text-neutral-500">{twoWaySummary(view.settings)}</span>}
			</button>
			{open && !view && !error && <p className="text-xs text-neutral-500">Asking the server what it supports…</p>}
			{open && view && (
				<TwoWayFields view={view} usable={usable} saving={saving} onSave={(settings) => void save(settings)} />
			)}
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
