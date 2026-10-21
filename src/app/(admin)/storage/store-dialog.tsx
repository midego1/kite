"use client";

import { useState } from "react";
import { CheckCircle2, Circle, Info, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { S3_PRESETS, presetFor } from "@/lib/storage/s3-presets-utils";
import { corsRuleJson } from "@/lib/storage/s3-utils";
import type { S3Provider } from "@/lib/storage/types";
import type { StoreForm, StoreView, ValidationStep } from "./types";
import {
	StorageRequestError,
	emptyStoreForm,
	endpointHint,
	errorText,
	storageRequest,
	storeFormBody,
	storeFormOf,
	withProvider,
} from "./utils";

const STEP_ICONS = {
	ok: <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-green-700" />,
	failed: <XCircle aria-hidden className="h-4 w-4 shrink-0 text-red-600" />,
	skipped: <Circle aria-hidden className="h-4 w-4 shrink-0 text-neutral-400" />,
	advice: <Info aria-hidden className="h-4 w-4 shrink-0 text-blue-600" />,
};

const STEP_STATUS = { ok: "passed", failed: "failed", skipped: "skipped", advice: "advice" };

export function StepList({ steps }: { steps: ValidationStep[] }) {
	return (
		<ul aria-label="Checks" className="space-y-2 text-sm">
			{steps.map((step) => (
				<li key={step.id} data-step={step.id} data-status={step.status} className="flex gap-2">
					{STEP_ICONS[step.status]}
					<div>
						<p className="text-neutral-900">
							{step.label}
							<span className="sr-only">: {STEP_STATUS[step.status]}</span>
						</p>
						{step.detail && <p className="text-neutral-600">{step.detail}</p>}
						{step.fix && <p className="text-neutral-500">{step.fix}</p>}
					</div>
				</li>
			))}
		</ul>
	);
}

function CorsSnippet() {
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-neutral-700">CORS rule for direct uploads</summary>
			<pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs text-neutral-800">
				{corsRuleJson([origin])}
			</pre>
		</details>
	);
}

type FieldsProps = {
	form: StoreForm;
	setForm: React.Dispatch<React.SetStateAction<StoreForm>>;
	store: StoreView | null;
	binding: boolean;
};

function StoreFields({ form, setForm, store, binding }: FieldsProps) {
	const editing = !!store;
	const preset = presetFor(form.provider);
	const set = (patch: Partial<StoreForm>) => setForm((current) => ({ ...current, ...patch }));
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="store-name">Name</Label>
					<Input
						id="store-name"
						value={form.name}
						maxLength={80}
						required
						onChange={(event) => set({ name: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="store-provider">Provider</Label>
					<Select
						id="store-provider"
						value={form.provider}
						disabled={binding || editing}
						containerClassName="h-10 w-full"
						onChange={(event) => setForm(withProvider(form, event.target.value as S3Provider))}
					>
						{S3_PRESETS.map((entry) => (
							<option key={entry.provider} value={entry.provider}>
								{entry.label}
							</option>
						))}
					</Select>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="store-endpoint">Endpoint</Label>
				<Input
					id="store-endpoint"
					value={form.endpoint}
					placeholder={endpointHint(form)}
					required
					onChange={(event) => set({ endpoint: event.target.value })}
				/>
			</div>
			<div className="grid gap-4 sm:grid-cols-3">
				<div className="space-y-1.5">
					<Label htmlFor="store-bucket">Bucket</Label>
					<Input
						id="store-bucket"
						value={form.bucket}
						required
						onChange={(event) => set({ bucket: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="store-region">Region</Label>
					<Input
						id="store-region"
						value={form.region}
						placeholder={preset?.region ?? "From the endpoint"}
						disabled={!!preset?.region}
						onChange={(event) => set({ region: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="store-addressing">Addressing</Label>
					<Select
						id="store-addressing"
						value={form.addressing}
						containerClassName="h-10 w-full"
						onChange={(event) => set({ addressing: event.target.value === "virtual" ? "virtual" : "path" })}
					>
						<option value="virtual">Virtual-hosted</option>
						<option value="path">Path-style</option>
					</Select>
				</div>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="store-key">Access key ID</Label>
					<Input
						id="store-key"
						value={form.accessKeyId}
						autoComplete="off"
						placeholder={store?.keyHint ? `Saved, ends in ${store.keyHint}` : undefined}
						required={!editing}
						onChange={(event) => set({ accessKeyId: event.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="store-secret">Secret access key</Label>
					<Input
						id="store-secret"
						type="password"
						value={form.secretAccessKey}
						autoComplete="new-password"
						placeholder={editing ? "Unchanged" : undefined}
						required={!editing}
						onChange={(event) => set({ secretAccessKey: event.target.value })}
					/>
				</div>
			</div>
		</>
	);
}

type Props = {
	/** The store being edited, or null to add one. */
	store: StoreView | null;
	/** Adds the R2 S3 API keys of the default bucket instead of a separate store. */
	binding?: boolean;
	onClose: () => void;
	onSaved: () => void;
};

function dialogText(binding: boolean, editing: boolean) {
	if (binding)
		return {
			title: "Enable direct uploads",
			description:
				"Add R2 S3 API keys for the default bucket so browsers upload Drive files to it directly. Create the keys under R2, Manage API tokens, with Object Read & Write on this bucket.",
		};
	return {
		title: editing ? "Edit store" : "Add store",
		description:
			"Kite checks the endpoint, the bucket and every permission it needs before saving. The secret is stored encrypted and never shown again.",
	};
}

export function StoreDialog({ store, binding = false, onClose, onSaved }: Props) {
	const editing = !!store;
	const [form, setForm] = useState<StoreForm>(() =>
		store ? storeFormOf(store) : emptyStoreForm(binding ? "r2" : "aws", binding),
	);
	const [steps, setSteps] = useState<ValidationStep[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// After a save whose CORS checks failed, the dialog stays open on the saved store so Apply CORS can run.
	const [savedId, setSavedId] = useState<string | null>(store?.id ?? null);
	const canApplyCors = !!savedId && !!presetFor(form.provider)?.applyCors;
	const added = !!savedId && !editing;
	const text = dialogText(binding, editing);

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const path = editing ? `/stores/${encodeURIComponent(store.id)}` : "/stores";
			const answer = await storageRequest<{
				store: StoreView;
				report: { cors: boolean; steps: ValidationStep[] } | null;
			}>(path, { method: editing ? "PATCH" : "POST", json: storeFormBody(form, editing) });
			onSaved();
			if (answer.report && !answer.report.cors) {
				setSteps(answer.report.steps);
				setSavedId(answer.store.id);
				setError("Saved. Browsers cannot upload to this store yet, which Drive needs; see the CORS checks.");
			} else onClose();
		} catch (caught) {
			setSteps(caught instanceof StorageRequestError ? (caught.details.report?.steps ?? null) : null);
			setError(errorText(caught, "Could not save the store"));
		} finally {
			setBusy(false);
		}
	}

	async function applyCors() {
		if (!savedId) return;
		setBusy(true);
		setError(null);
		try {
			const answer = await storageRequest<{ steps: ValidationStep[]; cors: boolean }>(
				`/stores/${encodeURIComponent(savedId)}/cors`,
				{ method: "POST" },
			);
			setSteps(answer.steps);
			setError(answer.cors ? null : "The rule was set, but the browser checks still fail.");
			onSaved();
		} catch (caught) {
			setError(errorText(caught, "Could not set the CORS rule"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(600px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{text.title}</DialogTitle>
					<DialogDescription>{text.description}</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={(event) => void save(event)}>
					<StoreFields form={form} setForm={setForm} store={store} binding={binding} />
					{error && (
						<p role="alert" className="text-sm text-red-600">
							{error}
						</p>
					)}
					{steps && <StepList steps={steps} />}
					<CorsSnippet />
					<div className="flex flex-wrap justify-end gap-2">
						{canApplyCors && (
							<Button type="button" variant="outline" disabled={busy} onClick={() => void applyCors()}>
								Apply CORS
							</Button>
						)}
						<Button type="button" variant="outline" onClick={onClose}>
							{added ? "Done" : "Cancel"}
						</Button>
						{!added && (
							<Button type="submit" disabled={busy}>
								{busy ? "Checking…" : editing ? "Check and save" : "Check and add"}
							</Button>
						)}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
