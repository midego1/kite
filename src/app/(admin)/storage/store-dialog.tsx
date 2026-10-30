"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normalizeR2AccountId, r2TokenPage } from "@/lib/storage/s3-presets-utils";
import { corsFailed, testSummary } from "./form-utils";
import {
	CorsRule,
	CredentialFields,
	CredentialsHelp,
	ExternalLinkText,
	Section,
	WhereSection,
	appOrigin,
} from "./store-fields";
import type { StoreView } from "./types";
import { StepList } from "./step-list";
import { AutoDirectUploads, R2OneClick } from "./r2-auto-setup";
import { useStoreDialog, type StoreDialogState } from "./use-store-dialog";

const SUMMARY_TONES = {
	ok: "border-green-600/30 bg-green-600/10 text-green-800",
	warn: "border-amber-500/30 bg-amber-50 text-amber-900",
	error: "border-red-600/30 bg-red-50 text-red-700",
};

function Results({ dialog }: { dialog: StoreDialogState }) {
	const { outcome, error } = dialog;
	const summary = outcome?.kind === "test" ? testSummary(outcome.steps) : null;
	if (!outcome && !error) return null;
	return (
		<div className="space-y-3" data-test-result={summary?.tone}>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{summary && (
				<p role="status" className={`rounded-lg border px-3 py-2 text-sm font-medium ${SUMMARY_TONES[summary.tone]}`}>
					{summary.text}
				</p>
			)}
			{outcome && <StepList steps={outcome.steps} checkedAt={outcome.at} />}
		</div>
	);
}

function Actions({ dialog, saveLabel, onClose }: { dialog: StoreDialogState; saveLabel: string; onClose: () => void }) {
	const { busy, added, canApplyCors, outcome } = dialog;
	return (
		<div className="flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4">
			{canApplyCors && corsFailed(outcome?.steps ?? null) && (
				<Button type="button" variant="outline" disabled={!!busy} onClick={() => void dialog.applyCors()}>
					{busy === "cors" ? "Applying…" : "Apply CORS"}
				</Button>
			)}
			{!added && (
				<Button type="button" variant="outline" disabled={!!busy} onClick={() => void dialog.test()}>
					{busy === "test" ? "Testing…" : "Test connection"}
				</Button>
			)}
			<Button type="button" variant="outline" onClick={onClose}>
				{added ? "Done" : "Cancel"}
			</Button>
			{!added && (
				<Button type="submit" disabled={!!busy}>
					{busy === "save" ? "Checking…" : saveLabel}
				</Button>
			)}
		</div>
	);
}

type Props = {
	/** The store being edited, or null to add one. */
	store: StoreView | null;
	onClose: () => void;
	onSaved: () => void;
};

const DIALOG_CLASS = "max-h-[calc(100vh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto";

/** Add or edit a store: where, credentials, direct uploads; Test connection checks without saving. */
export function StoreDialog({ store, onClose, onSaved }: Props) {
	const dialog = useStoreDialog({ store, binding: false, onClose, onSaved });
	const fields = { ...dialog, store };
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className={DIALOG_CLASS}>
				<DialogHeader>
					<DialogTitle>{dialog.editing ? "Edit store" : "Add store"}</DialogTitle>
					<DialogDescription>
						Test connection checks the endpoint, the keys and every permission Kite needs, without saving. The secret is
						stored encrypted and never shown again.
					</DialogDescription>
				</DialogHeader>
				{!dialog.editing && dialog.form.provider === "r2" && <R2OneClick onSaved={onSaved} onClose={onClose} />}
				<form className="space-y-4" noValidate onSubmit={(event) => void dialog.save(event)}>
					<Section title="Where">
						<WhereSection {...fields} binding={false} />
					</Section>
					<Section title="Credentials">
						<CredentialsHelp form={dialog.form} />
						<CredentialFields {...fields} />
					</Section>
					<Section title="Direct uploads">
						<p className="text-sm text-neutral-600">
							Drive can send large uploads straight from the browser to this bucket. That needs a CORS rule on the
							bucket; the test checks it.
						</p>
						<CorsRule />
					</Section>
					<Results dialog={dialog} />
					<Actions dialog={dialog} saveLabel={dialog.editing ? "Check and save" : "Check and add"} onClose={onClose} />
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Direct uploads for the default R2 bucket, as a guided flow: create the token, paste it, test, save. The keys
 * only sign browser uploads to the Worker's own bucket; nothing moves.
 */
export function DirectUploadsDialog({ onClose, onSaved }: Omit<Props, "store">) {
	const dialog = useStoreDialog({ store: null, binding: true, onClose, onSaved });
	const fields = { ...dialog, store: null };
	const bucket = dialog.form.bucket.trim() || "your bucket";
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className={DIALOG_CLASS}>
				<DialogHeader>
					<DialogTitle>Enable direct uploads</DialogTitle>
					<DialogDescription>
						Large Drive uploads go straight to R2: faster, and less load on the Worker. Kite needs an R2 API token for
						the bucket to sign those uploads. It takes about two minutes.
					</DialogDescription>
				</DialogHeader>
				<AutoDirectUploads onSaved={onSaved} onClose={onClose} />
				<form className="space-y-4" noValidate onSubmit={(event) => void dialog.save(event)}>
					<Section step={1} title="Create an R2 API token">
						<p className="text-sm text-neutral-600">
							In the Cloudflare dashboard, create an R2 API token with the permission{" "}
							<strong className="font-semibold text-neutral-900">Object Read & Write</strong>, applied to the bucket{" "}
							<strong className="font-semibold text-neutral-900">{bucket}</strong> only. Cloudflare shows the keys once.
						</p>
						<p className="text-sm">
							<ExternalLinkText href={r2TokenPage(normalizeR2AccountId(dialog.form.accountId))}>
								Open R2 API tokens
							</ExternalLinkText>
						</p>
					</Section>
					<Section step={2} title="Paste the keys and your account ID">
						<WhereSection {...fields} binding />
						<CredentialFields {...fields} />
					</Section>
					<Section step={3} title="Test the connection">
						<p className="text-sm text-neutral-600">
							Kite writes, reads, lists and deletes a small test file, and checks that browsers may upload from{" "}
							<span className="font-mono">{appOrigin()}</span>. Nothing is saved yet.
						</p>
						<CorsRule />
					</Section>
					<Section step={4} title="Save">
						<p className="text-sm text-neutral-600">
							Saving runs the same checks. If only the browser check fails, use Apply CORS and Kite sets the rule.
						</p>
					</Section>
					<Results dialog={dialog} />
					<Actions dialog={dialog} saveLabel="Save and enable" onClose={onClose} />
				</form>
			</DialogContent>
		</Dialog>
	);
}
