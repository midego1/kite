"use client";

import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useModules } from "@/components/modules/modules-context";
import { Switch } from "@/components/ui/switch";
import type {
	AutoReadForm,
	AutoReadSettingsProps,
	AutoReadSettingsState,
	AutoReadStatus,
} from "./auto-read-settings-types";
import {
	AGENT_SETTINGS_CHANGED_EVENT,
	AUTONOMY_OPTIONS,
	autoReadUpdateBody,
	CAPABILITY_OPTIONS,
	loadAutoReadSettings,
	moduleStepSwitches,
	pauseEndFrom,
	saveAutoReadSettings,
	toAutoReadState,
} from "./auto-read-settings-utils";

const fieldClass =
	"mt-2 w-full rounded-xl border border-neutral-200 bg-white p-2 outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-60";

function AutonomyOptions({
	mailboxId,
	value,
	disabled,
	onChange,
}: {
	mailboxId: string;
	value: AutoReadForm["autonomy"];
	disabled: boolean;
	onChange: (value: AutoReadForm["autonomy"]) => void;
}) {
	return (
		<fieldset className="space-y-1.5">
			<legend className="mb-1.5 text-neutral-800">Autonomy</legend>
			{AUTONOMY_OPTIONS.map((option) => {
				const noteId = `auto-read-${option.value}-note-${mailboxId}`;
				return (
					<div key={option.value} className="flex flex-wrap items-center gap-x-2">
						<label
							className={`flex items-center gap-2 ${option.available ? "" : "cursor-not-allowed text-neutral-400"}`}
						>
							<input
								type="radio"
								className="h-4 w-4 accent-blue-600 disabled:cursor-not-allowed"
								name={`auto-read-autonomy-${mailboxId}`}
								value={option.value}
								checked={value === option.value}
								disabled={disabled || !option.available}
								aria-describedby={option.available ? undefined : noteId}
								onChange={() => onChange(option.value)}
							/>
							<span>{option.label}</span>
						</label>
						{!option.available && (
							<span id={noteId} className="text-xs text-neutral-500">
								Not available yet
							</span>
						)}
					</div>
				);
			})}
		</fieldset>
	);
}

function CapabilityToggles({
	value,
	disabled,
	onChange,
}: {
	value: AutoReadForm["capabilities"];
	disabled: boolean;
	onChange: (value: AutoReadForm["capabilities"]) => void;
}) {
	const { modules } = useModules();
	return (
		<div className="space-y-2">
			<p className="text-neutral-800">What Kite looks for</p>
			{CAPABILITY_OPTIONS.map((option) => (
				<div key={option.key} className="flex items-center justify-between gap-3">
					<span>{option.label}</span>
					<Switch
						checked={value[option.key]}
						disabled={disabled}
						onCheckedChange={(checked) => onChange({ ...value, [option.key]: checked })}
						aria-label={option.label}
					/>
				</div>
			))}
			{moduleStepSwitches(modules).map((option) => (
				<div key={`module-${option.key}`} className="flex items-center justify-between gap-3">
					<span>{option.label}</span>
					<Switch
						checked={value.modules[option.key] !== false}
						disabled={disabled}
						onCheckedChange={(checked) => onChange({ ...value, modules: { ...value.modules, [option.key]: checked } })}
						aria-label={option.label}
					/>
				</div>
			))}
		</div>
	);
}

function AutoReadNotices({ state }: { state: AutoReadSettingsState }) {
	return (
		<>
			{!state.autoReadAvailable && (
				<p className="text-amber-700">
					An admin has turned automatic reading off for this installation. These settings take effect when it is turned
					back on.
				</p>
			)}
			{state.externalProviderBlocked && (
				<p className="text-amber-700">
					Automatic reading uses {state.providerLabel}, an external provider. The primary admin must allow the external
					provider for automatic reading on the Agent admin page before Kite reads any mail.
				</p>
			)}
			{!state.canManage && (
				<p className="text-neutral-600">Full mailbox access is required to change automatic reading.</p>
			)}
		</>
	);
}

function PauseControl({
	pausedUntil,
	disabled,
	onPause,
}: {
	pausedUntil: string | null;
	disabled: boolean;
	onPause: (pausedUntil: string | null) => void;
}) {
	if (pausedUntil)
		return (
			<div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-blue-50 p-2 text-blue-900">
				<span role="status">
					Paused until {new Date(pausedUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
				</span>
				<Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onPause(null)}>
					Resume
				</Button>
			</div>
		);
	return (
		<Button
			type="button"
			size="sm"
			variant="outline"
			disabled={disabled}
			onClick={() => onPause(pauseEndFrom(Date.now()))}
		>
			Pause for 24 hours
		</Button>
	);
}

function AutoReadFields({
	mailboxId,
	state,
	busy,
	setForm,
}: {
	mailboxId: string;
	state: AutoReadSettingsState;
	busy: boolean;
	setForm: (update: Partial<AutoReadForm>) => void;
}) {
	const locked = !state.canManage || busy;
	const { form } = state;
	return (
		<>
			<AutonomyOptions
				mailboxId={mailboxId}
				value={form.autonomy}
				disabled={locked}
				onChange={(autonomy) => setForm({ autonomy })}
			/>
			<CapabilityToggles
				value={form.capabilities}
				disabled={locked}
				onChange={(capabilities) => setForm({ capabilities })}
			/>
			<label className="block">
				Triage model
				<select
					className={fieldClass}
					value={form.triageModelId}
					disabled={locked}
					onChange={(event) => setForm({ triageModelId: event.target.value })}
				>
					<option value="">Automatic (cheapest configured model)</option>
					{state.models.map((model) => (
						<option key={model} value={model}>
							{model}
						</option>
					))}
				</select>
			</label>
			<label className="block">
				Daily triage limit
				<input
					className={fieldClass}
					type="number"
					min="1"
					max="1000"
					value={form.dailyLimit}
					disabled={locked}
					onChange={(event) => setForm({ dailyLimit: event.target.value })}
				/>
			</label>
			<label className="block">
				Daily spend cap for this mailbox (USD)
				<input
					className={fieldClass}
					type="number"
					min="0"
					step="0.01"
					placeholder="No mailbox cap"
					value={form.spendCap}
					disabled={locked}
					onChange={(event) => setForm({ spendCap: event.target.value })}
				/>
			</label>
		</>
	);
}

/** Follows a pause set or undone elsewhere (the reader card) without discarding unsaved form edits. */
function usePauseChangedElsewhere(mailboxId: string, setState: Dispatch<SetStateAction<AutoReadSettingsState | null>>) {
	useEffect(() => {
		let active = true;
		function onChanged(event: Event) {
			if ((event as CustomEvent<{ mailboxId?: string }>).detail?.mailboxId !== mailboxId) return;
			loadAutoReadSettings(mailboxId)
				.then((data) => {
					const next = toAutoReadState(data, Date.now());
					if (active) setState((current) => (current && next ? { ...current, pausedUntil: next.pausedUntil } : next));
				})
				.catch(() => undefined);
		}
		window.addEventListener(AGENT_SETTINGS_CHANGED_EVENT, onChanged);
		return () => {
			active = false;
			window.removeEventListener(AGENT_SETTINGS_CHANGED_EVENT, onChanged);
		};
	}, [mailboxId, setState]);
}

export function AutoReadSettings({ mailboxId }: AutoReadSettingsProps) {
	const [state, setState] = useState<AutoReadSettingsState | null>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<AutoReadStatus>(null);

	const load = useCallback(async () => {
		const next = toAutoReadState(await loadAutoReadSettings(mailboxId), Date.now());
		setState(next);
	}, [mailboxId]);
	usePauseChangedElsewhere(mailboxId, setState);

	useEffect(() => {
		let active = true;
		loadAutoReadSettings(mailboxId)
			.then((data) => {
				if (active) setState(toAutoReadState(data, Date.now()));
			})
			.catch((error: unknown) => {
				if (active)
					setStatus({
						tone: "error",
						text: error instanceof Error ? error.message : "Could not load automatic reading settings",
					});
			});
		return () => {
			active = false;
		};
	}, [mailboxId]);

	if (!state)
		return status ? (
			<p role="alert" className="text-xs text-red-600">
				{status.text}
			</p>
		) : null;

	async function run(action: () => Promise<void>, done: string) {
		setBusy(true);
		setStatus(null);
		try {
			await action();
			await load();
			setStatus({ tone: "ok", text: done });
		} catch (error) {
			setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save" });
		} finally {
			setBusy(false);
		}
	}

	function save() {
		if (!state) return;
		const body = autoReadUpdateBody(mailboxId, state.form);
		if (typeof body === "string") return setStatus({ tone: "error", text: body });
		void run(() => saveAutoReadSettings(body), "Saved");
	}

	function pause(pausedUntil: string | null) {
		void run(() => saveAutoReadSettings({ mailboxId, pausedUntil }), pausedUntil ? "Paused" : "Resumed");
	}

	const setForm = (update: Partial<AutoReadForm>) =>
		setState((current) => (current ? { ...current, form: { ...current.form, ...update } } : current));

	return (
		<section
			aria-labelledby={`auto-read-heading-${mailboxId}`}
			className="space-y-3 rounded-2xl border border-neutral-200 p-3"
		>
			<p id={`auto-read-heading-${mailboxId}`} className="font-medium text-neutral-800">
				Automatic reading
			</p>
			<p className="text-xs text-neutral-500">
				Kite reads new mail in this mailbox and suggests summaries, replies and warnings. Nothing changes until you
				accept a suggestion.
			</p>
			<AutoReadNotices state={state} />
			<AutoReadFields mailboxId={mailboxId} state={state} busy={busy} setForm={setForm} />
			<p className="text-xs text-neutral-500">Message content is sent to {state.providerLabel}.</p>
			{state.canManage && (
				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" size="sm" disabled={busy} onClick={save}>
						Save automatic reading
					</Button>
					<PauseControl
						pausedUntil={state.pausedUntil}
						disabled={busy || (state.savedAutonomy === "off" && !state.pausedUntil)}
						onPause={pause}
					/>
				</div>
			)}
			{status && (
				<p role="status" className={`text-xs ${status.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
					{status.text}
				</p>
			)}
		</section>
	);
}
