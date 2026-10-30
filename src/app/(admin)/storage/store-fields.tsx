"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import toast from "react-hot-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { S3_PRESETS, presetFor, r2TokenPage, normalizeR2AccountId } from "@/lib/storage/s3-presets-utils";
import { corsRuleJson } from "@/lib/storage/s3-utils";
import { storePolicy } from "@/lib/storage/validate-utils";
import type { S3Provider } from "@/lib/storage/types";
import { endpointPlaceholder, formEndpoint, usesPresetEndpoint, withProvider } from "./form-utils";
import type { StoreForm, StoreFormErrors, StoreFormField, StoreView } from "./types";

export type FieldsProps = {
	form: StoreForm;
	setForm: React.Dispatch<React.SetStateAction<StoreForm>>;
	errors: StoreFormErrors;
	onBlur: (field: StoreFormField) => void;
	store: StoreView | null;
};

type FieldProps = {
	id: string;
	label: string;
	help?: React.ReactNode;
	error?: string;
	className?: string;
	children: (described: { "aria-describedby"?: string; "aria-invalid"?: true }) => React.ReactNode;
};

/** A label, the control, its helper text and its error, wired up with aria-describedby. */
function Field({ id, label, help, error, className, children }: FieldProps) {
	const ids = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
	return (
		<div className={`space-y-1.5 ${className ?? ""}`}>
			<Label htmlFor={id}>{label}</Label>
			{children({ ...(ids ? { "aria-describedby": ids } : {}), ...(error ? { "aria-invalid": true } : {}) })}
			{help && (
				<p id={`${id}-help`} className="text-xs text-neutral-500">
					{help}
				</p>
			)}
			{error && (
				<p id={`${id}-error`} className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}

export function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="inline-flex items-center gap-1 font-medium text-blue-700 underline-offset-2 hover:underline"
		>
			{children}
			<ExternalLink aria-hidden className="h-3 w-3" />
			<span className="sr-only">(opens in a new tab)</span>
		</a>
	);
}

/** A block of text with a Copy button, for the CORS rule and the IAM policy. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const copy = () =>
		void navigator.clipboard.writeText(text).then(
			() => {
				setCopied(true);
				toast.success(`${label} copied`);
				setTimeout(() => setCopied(false), 2000);
			},
			() => toast.error(`Could not copy the ${label}`),
		);
	return (
		<div className="relative">
			<pre className="max-h-48 overflow-auto rounded-lg bg-neutral-100 p-3 pr-20 text-xs text-neutral-800">{text}</pre>
			<button
				type="button"
				onClick={copy}
				className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
			>
				{copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
				{copied ? "Copied" : `Copy ${label}`}
			</button>
		</div>
	);
}

export function appOrigin(): string {
	return typeof window === "undefined" ? "" : window.location.origin;
}

/** The rule direct uploads need, with this site's origin filled in. */
export function CorsRule({ open = false }: { open?: boolean }) {
	return (
		<details className="text-sm" open={open}>
			<summary className="cursor-pointer font-medium text-neutral-700">CORS rule for direct uploads</summary>
			<p className="mt-2 text-neutral-600">
				Browsers upload Drive files straight to the bucket from <span className="font-mono">{appOrigin()}</span>. The
				bucket must allow that origin; add this rule to its CORS settings, or use Apply CORS once the store is saved
				where the provider allows it.
			</p>
			<div className="mt-2">
				<CopyBlock label="CORS rule" text={corsRuleJson([appOrigin()])} />
			</div>
		</details>
	);
}

function ProviderField({
	form,
	setForm,
	store,
	binding,
}: Pick<FieldsProps, "form" | "setForm" | "store"> & { binding: boolean }) {
	return (
		<Field id="store-provider" label="Provider">
			{(described) => (
				<Select
					id="store-provider"
					value={form.provider}
					disabled={binding || !!store}
					containerClassName="h-10 w-full"
					onChange={(event) => setForm(withProvider(form, event.target.value as S3Provider))}
					{...described}
				>
					{S3_PRESETS.map((entry) => (
						<option key={entry.provider} value={entry.provider}>
							{entry.label}
						</option>
					))}
				</Select>
			)}
		</Field>
	);
}

const OTHER_REGION = "__other";

function RegionField({ form, setForm, errors, onBlur }: Omit<FieldsProps, "store">) {
	const regions = presetFor(form.provider)?.regions ?? [];
	const listed = regions.some((region) => region.value === form.region);
	const [other, setOther] = useState(!!form.region && !listed);
	const choice = other ? OTHER_REGION : form.region;
	return (
		<>
			<Field id="store-region" label="Region" error={other ? undefined : errors.region}>
				{(described) => (
					<Select
						id="store-region"
						value={choice}
						containerClassName="h-10 w-full"
						onChange={(event) => {
							const value = event.target.value;
							setOther(value === OTHER_REGION);
							setForm((current) => ({ ...current, region: value === OTHER_REGION ? "" : value }));
							onBlur("region");
						}}
						{...described}
					>
						<option value="">Choose a region</option>
						{regions.map((region) => (
							<option key={region.value} value={region.value}>
								{region.label}
							</option>
						))}
						<option value={OTHER_REGION}>Another region…</option>
					</Select>
				)}
			</Field>
			{other && (
				<Field id="store-region-custom" label="Custom region" error={errors.region}>
					{(described) => (
						<Input
							id="store-region-custom"
							value={form.region}
							placeholder="eu-central-1"
							onBlur={() => onBlur("region")}
							onChange={(event) => setForm((current) => ({ ...current, region: event.target.value }))}
							{...described}
						/>
					)}
				</Field>
			)}
		</>
	);
}

function R2AccountFields({ form, setForm, errors, onBlur }: Omit<FieldsProps, "store">) {
	return (
		<>
			<Field
				id="store-account"
				label="Cloudflare account ID"
				className="sm:col-span-2"
				error={errors.accountId}
				help="On the R2 overview page, under Account details. Pasting the bucket's S3 API URL works too."
			>
				{(described) => (
					<Input
						id="store-account"
						value={form.accountId}
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
						placeholder="32 letters and digits"
						onBlur={() => {
							setForm((current) => ({ ...current, accountId: normalizeR2AccountId(current.accountId) }));
							onBlur("accountId");
						}}
						onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}
						{...described}
					/>
				)}
			</Field>
			<Field id="store-jurisdiction" label="Jurisdiction" help="Only for buckets created with a jurisdiction.">
				{(described) => (
					<Select
						id="store-jurisdiction"
						value={form.jurisdiction}
						containerClassName="h-10 w-full"
						onChange={(event) =>
							setForm((current) => ({
								...current,
								jurisdiction: event.target.value === "eu" ? "eu" : event.target.value === "fedramp" ? "fedramp" : "",
							}))
						}
						{...described}
					>
						<option value="">Default</option>
						<option value="eu">European Union</option>
						<option value="fedramp">FedRAMP</option>
					</Select>
				)}
			</Field>
		</>
	);
}

function EndpointFields({ form, setForm, errors, onBlur }: Omit<FieldsProps, "store">) {
	const preset = presetFor(form.provider);
	return (
		<>
			<Field id="store-endpoint" label="Endpoint" className="sm:col-span-2" error={errors.endpoint}>
				{(described) => (
					<Input
						id="store-endpoint"
						value={form.endpoint}
						inputMode="url"
						spellCheck={false}
						placeholder={endpointPlaceholder(form)}
						onBlur={() => onBlur("endpoint")}
						onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))}
						{...described}
					/>
				)}
			</Field>
			{!preset?.region && (
				<Field id="store-region" label="Region" error={errors.region}>
					{(described) => (
						<Input
							id="store-region"
							value={form.region}
							placeholder="us-east-1"
							onBlur={() => onBlur("region")}
							onChange={(event) => setForm((current) => ({ ...current, region: event.target.value }))}
							{...described}
						/>
					)}
				</Field>
			)}
			<Field id="store-addressing" label="Addressing" help="Path-style works for most self-hosted stores.">
				{(described) => (
					<Select
						id="store-addressing"
						value={form.addressing}
						containerClassName="h-10 w-full"
						onChange={(event) =>
							setForm((current) => ({ ...current, addressing: event.target.value === "virtual" ? "virtual" : "path" }))
						}
						{...described}
					>
						<option value="path">Path-style</option>
						<option value="virtual">Virtual-hosted</option>
					</Select>
				)}
			</Field>
		</>
	);
}

/** Provider, where the bucket is and how it is reached. */
export function WhereSection(props: FieldsProps & { binding: boolean }) {
	const { form, setForm, errors, onBlur, binding } = props;
	const preset = presetFor(form.provider);
	const fromPreset = usesPresetEndpoint(form);
	const endpoint = formEndpoint(form);
	const canCustomize = !!preset?.endpoint && !binding;
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{!binding && (
				<>
					<Field id="store-name" label="Name" error={errors.name} help="Shown on this page only.">
						{(described) => (
							<Input
								id="store-name"
								value={form.name}
								maxLength={80}
								placeholder="Archive bucket"
								onBlur={() => onBlur("name")}
								onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
								{...described}
							/>
						)}
					</Field>
					<ProviderField {...props} />
				</>
			)}
			{fromPreset && form.provider === "r2" && <R2AccountFields {...props} />}
			{fromPreset && form.provider !== "r2" && <RegionField key={form.provider} {...props} />}
			<Field id="store-bucket" label="Bucket" error={errors.bucket}>
				{(described) => (
					<Input
						id="store-bucket"
						value={form.bucket}
						spellCheck={false}
						autoCapitalize="off"
						placeholder="kite-files"
						onBlur={() => onBlur("bucket")}
						onChange={(event) => setForm((current) => ({ ...current, bucket: event.target.value }))}
						{...described}
					/>
				)}
			</Field>
			{!fromPreset && <EndpointFields {...props} />}
			{fromPreset && (
				<p className="text-xs text-neutral-500 sm:col-span-2" data-endpoint-preview>
					Endpoint:{" "}
					<span className="font-mono break-all text-neutral-700">{endpoint || endpointPlaceholder(form)}</span>
				</p>
			)}
			{canCustomize && (
				<label className="flex items-center gap-2 text-sm text-neutral-700 sm:col-span-2">
					<input
						type="checkbox"
						className="h-4 w-4 accent-blue-600"
						checked={form.customEndpoint}
						onChange={(event) =>
							setForm((current) => ({
								...current,
								customEndpoint: event.target.checked,
								endpoint: event.target.checked ? formEndpoint(current) : current.endpoint,
							}))
						}
					/>
					Use a custom endpoint
				</label>
			)}
		</div>
	);
}

function SecretField({ form, setForm, errors, onBlur, store }: FieldsProps) {
	const [shown, setShown] = useState(false);
	return (
		<Field id="store-secret" label="Secret access key" error={errors.secretAccessKey}>
			{(described) => (
				<div className="relative">
					<Input
						id="store-secret"
						type={shown ? "text" : "password"}
						value={form.secretAccessKey}
						autoComplete="new-password"
						spellCheck={false}
						className="pr-11 font-mono"
						placeholder={store ? "Unchanged" : undefined}
						onBlur={() => onBlur("secretAccessKey")}
						onChange={(event) => setForm((current) => ({ ...current, secretAccessKey: event.target.value }))}
						{...described}
					/>
					<button
						type="button"
						aria-label={shown ? "Hide secret" : "Show secret"}
						aria-pressed={shown}
						onClick={() => setShown((value) => !value)}
						className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-neutral-500 hover:text-neutral-800"
					>
						{shown ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
					</button>
				</div>
			)}
		</Field>
	);
}

/** Where to create the key pair and which permission it needs, linked to the provider's own page. */
export function CredentialsHelp({ form }: { form: StoreForm }) {
	const preset = presetFor(form.provider);
	const page =
		form.provider === "r2"
			? { url: r2TokenPage(normalizeR2AccountId(form.accountId)), label: "R2 API tokens" }
			: preset?.tokenPage;
	return (
		<div className="space-y-2 text-sm text-neutral-600">
			<p>
				{preset?.credentialsHelp}
				{page && (
					<>
						{" "}
						<ExternalLinkText href={page.url}>Open {page.label}</ExternalLinkText>
					</>
				)}
			</p>
			{form.provider === "aws" && (
				<details>
					<summary className="cursor-pointer font-medium text-neutral-700">IAM policy for this bucket</summary>
					<div className="mt-2">
						<CopyBlock
							label="IAM policy"
							text={JSON.stringify(storePolicy(form.bucket.trim() || "your-bucket"), null, 2)}
						/>
					</div>
				</details>
			)}
		</div>
	);
}

export function CredentialFields(props: FieldsProps) {
	const { form, setForm, errors, onBlur, store } = props;
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<Field id="store-key" label="Access key ID" error={errors.accessKeyId}>
				{(described) => (
					<Input
						id="store-key"
						value={form.accessKeyId}
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
						placeholder={store?.keyHint ? `Saved, ends in ${store.keyHint}` : undefined}
						onBlur={() => onBlur("accessKeyId")}
						onChange={(event) => setForm((current) => ({ ...current, accessKeyId: event.target.value }))}
						{...described}
					/>
				)}
			</Field>
			<SecretField {...props} />
		</div>
	);
}

/** A titled group of fields; a fieldset so screen readers announce the section with each field. */
export function Section({ title, step, children }: { title: string; step?: number; children: React.ReactNode }) {
	return (
		<fieldset className="space-y-3 rounded-xl border border-neutral-200 p-4">
			<legend className="flex items-center gap-2 px-1 text-sm font-semibold text-neutral-900">
				{step !== undefined && (
					<span
						aria-hidden
						className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white"
					>
						{step}
					</span>
				)}
				{step !== undefined && <span className="sr-only">Step {step}: </span>}
				{title}
			</legend>
			{children}
		</fieldset>
	);
}
