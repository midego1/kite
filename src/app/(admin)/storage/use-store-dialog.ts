"use client";

import { useState } from "react";
import { presetFor } from "@/lib/storage/s3-presets-utils";
import { emptyStoreForm, storeFormBody, storeFormErrors, storeFormOf } from "./form-utils";
import type { StoreForm, StoreFormErrors, StoreFormField, StoreView, ValidationStep } from "./types";
import { StorageRequestError, errorText, storageRequest } from "./utils";

type Options = { store: StoreView | null; binding: boolean; onSaved: () => void; onClose: () => void };

type Outcome = { kind: "test" | "save"; steps: ValidationStep[]; at: Date } | null;

const FIELD_IDS: Record<StoreFormField, string> = {
	name: "store-name",
	accountId: "store-account",
	region: "store-region",
	endpoint: "store-endpoint",
	bucket: "store-bucket",
	accessKeyId: "store-key",
	secretAccessKey: "store-secret",
};

/**
 * The Add, Edit and direct-uploads dialogs' state: the form, its field errors (shown once a field was left or a
 * check was asked for), Test connection, Check and save, and Apply CORS after a save whose browser checks failed.
 */
export function useStoreDialog({ store, binding, onSaved, onClose }: Options) {
	const editing = !!store;
	const [form, setFormState] = useState<StoreForm>(() =>
		store ? storeFormOf(store) : emptyStoreForm(binding ? "r2" : "aws", binding),
	);
	const [touched, setTouched] = useState<Set<StoreFormField>>(() => new Set());
	const [attempted, setAttempted] = useState(false);
	const [outcome, setOutcome] = useState<Outcome>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"test" | "save" | "cors" | null>(null);
	// After a save whose CORS checks failed, the dialog stays open on the saved store so Apply CORS can run.
	const [savedId, setSavedId] = useState<string | null>(store?.id ?? null);

	// A 400 about one field (from the server's own parse), shown under it until the form changes.
	const [serverError, setServerError] = useState<StoreFormErrors>({});
	const allErrors = storeFormErrors(form, { editing });
	const errors: StoreFormErrors = {
		...Object.fromEntries(
			Object.entries(allErrors).filter(([field]) => attempted || touched.has(field as StoreFormField)),
		),
		...serverError,
	};

	// A test result describes the form as it was, so any change clears it.
	const setForm: React.Dispatch<React.SetStateAction<StoreForm>> = (next) => {
		setFormState(next);
		setServerError({});
		setOutcome((current) => (current?.kind === "test" ? null : current));
	};

	/** A failed request: its message under the field it names, else in the alert. */
	function failed(caught: unknown, fallback: string) {
		const field = caught instanceof StorageRequestError ? caught.details.field : undefined;
		if (field && field in FIELD_IDS) {
			setServerError({ [field]: errorText(caught, fallback) });
			document.getElementById(FIELD_IDS[field as StoreFormField])?.focus();
		} else setError(errorText(caught, fallback));
	}

	function ready(): boolean {
		setAttempted(true);
		const first = Object.keys(allErrors)[0] as StoreFormField | undefined;
		if (!first) return true;
		const element = document.getElementById(FIELD_IDS[first]) ?? document.getElementById("store-region-custom");
		element?.focus();
		return false;
	}

	async function test() {
		if (!ready()) return;
		setBusy("test");
		setError(null);
		setServerError({});
		setOutcome(null);
		try {
			const answer = await storageRequest<{ report: { steps: ValidationStep[] } }>("/test", {
				method: "POST",
				json: storeFormBody(form, editing, store?.id),
			});
			setOutcome({ kind: "test", steps: answer.report.steps, at: new Date() });
		} catch (caught) {
			failed(caught, "Could not test the connection");
		} finally {
			setBusy(null);
		}
	}

	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (!ready()) return;
		setBusy("save");
		setError(null);
		setServerError({});
		try {
			const path = editing ? `/stores/${encodeURIComponent(store.id)}` : "/stores";
			const answer = await storageRequest<{
				store: StoreView;
				report: { cors: boolean; steps: ValidationStep[] } | null;
			}>(path, { method: editing ? "PATCH" : "POST", json: storeFormBody(form, editing) });
			onSaved();
			if (answer.report && !answer.report.cors) {
				setOutcome({ kind: "save", steps: answer.report.steps, at: new Date() });
				setSavedId(answer.store.id);
				setError("Saved. Browsers cannot upload to this store yet, which Drive needs; see the CORS checks.");
			} else onClose();
		} catch (caught) {
			const steps = caught instanceof StorageRequestError ? caught.details.report?.steps : undefined;
			setOutcome(steps ? { kind: "save", steps, at: new Date() } : null);
			failed(caught, "Could not save the store");
		} finally {
			setBusy(null);
		}
	}

	async function applyCors() {
		if (!savedId) return;
		setBusy("cors");
		setError(null);
		try {
			const answer = await storageRequest<{ steps: ValidationStep[]; cors: boolean }>(
				`/stores/${encodeURIComponent(savedId)}/cors`,
				{ method: "POST" },
			);
			setOutcome({ kind: "save", steps: answer.steps, at: new Date() });
			setError(answer.cors ? null : "The rule was set, but the browser checks still fail.");
			onSaved();
		} catch (caught) {
			setError(errorText(caught, "Could not set the CORS rule"));
		} finally {
			setBusy(null);
		}
	}

	return {
		editing,
		form,
		setForm,
		errors,
		// Leaving an empty field says nothing yet: its error would shift the layout under a click on Test or Save.
		onBlur: (field: StoreFormField) => {
			if (form[field].trim()) setTouched((current) => new Set(current).add(field));
		},
		outcome,
		error,
		busy,
		added: !!savedId && !editing,
		canApplyCors: !!savedId && !!presetFor(form.provider)?.applyCors,
		test,
		save,
		applyCors,
	};
}

export type StoreDialogState = ReturnType<typeof useStoreDialog>;
