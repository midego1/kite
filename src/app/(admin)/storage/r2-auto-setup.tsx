"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
	R2_LOCATION_HINTS,
	R2_PERMISSIONS,
	r2BucketNameProblem,
	suggestedBucketName,
} from "@/lib/storage/cloudflare-r2-utils";
import type { RoutableClass } from "@/lib/storage/types";
import { Section, appOrigin } from "./store-fields";
import { StepList } from "./step-list";
import type { ListStep, R2Choices } from "./types";
import { CLASS_LABELS, StorageRequestError, errorText, storageRequest } from "./utils";

const R2_CHOICES_KEY = ["admin-storage-cloudflare"];

/** Whether the one-click setup can run, and the account's buckets; asked once per dialog. */
function useR2Choices() {
	return useQuery({
		queryKey: R2_CHOICES_KEY,
		queryFn: () => storageRequest<R2Choices>("/cloudflare"),
		staleTime: 30_000,
		retry: false,
	});
}

type SetupState = {
	busy: boolean;
	steps: ListStep[] | null;
	error: string | null;
	code?: string;
	bucket?: string;
	done: boolean;
};

/** Runs one automatic setup request and keeps its step list, refusal and whether it finished. */
function useR2Setup(onSaved: () => void) {
	const queryClient = useQueryClient();
	const [state, setState] = useState<SetupState>({ busy: false, steps: null, error: null, done: false });
	async function run(path: string, body: Record<string, unknown>) {
		setState({ busy: true, steps: null, error: null, done: false });
		try {
			const answer = await storageRequest<{ steps: ListStep[] }>(path, { method: "POST", json: body });
			setState({ busy: false, steps: answer.steps, error: null, done: true });
			// A new bucket belongs in the pickers from now on.
			void queryClient.invalidateQueries({ queryKey: R2_CHOICES_KEY });
			onSaved();
		} catch (caught) {
			const details = caught instanceof StorageRequestError ? caught.details : {};
			setState({
				busy: false,
				steps: details.steps ?? null,
				error: errorText(caught, "The automatic setup failed"),
				code: details.code,
				bucket: typeof body.bucket === "string" ? body.bucket : undefined,
				done: false,
			});
		}
	}
	return { ...state, run };
}

function SetupResult({ state, success }: { state: SetupState; success: string }) {
	return (
		<div className="space-y-3" data-auto-setup={state.done ? "done" : state.error ? "failed" : undefined}>
			{state.done && (
				<p role="status" className="text-sm font-medium text-green-800">
					{success}
				</p>
			)}
			{state.error && (
				<p role="alert" className="text-sm text-red-600">
					{state.error}
				</p>
			)}
			{state.steps && state.steps.length > 0 && <StepList steps={state.steps} noun="steps" />}
		</div>
	);
}

function TokenTradeOff() {
	return (
		<p className="text-xs text-neutral-500">
			This needs the account permissions <strong className="font-medium">{R2_PERMISSIONS.buckets}</strong> and{" "}
			<strong className="font-medium">{R2_PERMISSIONS.tokens}</strong> on CF_TOKEN. Creating API tokens is a powerful
			permission: grant it for the setup and remove it afterwards. The bucket token Kite creates keeps working.
		</p>
	);
}

const bucketLabel = (bucket: { name: string; jurisdiction: string }) =>
	bucket.jurisdiction ? `${bucket.name} (${bucket.jurisdiction.toUpperCase()})` : bucket.name;

const bucketValue = (bucket: { name: string; jurisdiction: string }) => `${bucket.jurisdiction}:${bucket.name}`;

function splitBucketValue(value: string): { jurisdiction: string; bucket: string } {
	const at = value.indexOf(":");
	return { jurisdiction: value.slice(0, at), bucket: value.slice(at + 1) };
}

function Unavailable({ choices }: { choices: R2Choices | undefined }) {
	if (!choices) return <p className="text-sm text-neutral-500">Checking Cloudflare…</p>;
	return (
		<p className="text-sm text-neutral-500" data-auto-setup="unavailable">
			Automatic setup is not available here: {choices.reason}
		</p>
	);
}

/**
 * The first section of Enable direct uploads: one click creates a token for the default bucket with CF_TOKEN, sets
 * its CORS rule and saves the keys. The guided steps below stay as the manual fallback.
 */
export function AutoDirectUploads({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
	const choices = useR2Choices();
	const setup = useR2Setup(onSaved);
	const data = choices.data;
	const fallback = data?.defaultBucket ?? "kite-raw";
	const buckets = data?.buckets ?? [];
	const preferred = buckets.find((bucket) => bucket.name === fallback && !bucket.jurisdiction) ?? buckets[0];
	const [picked, setPicked] = useState<string | null>(null);
	const value = picked ?? (preferred ? bucketValue(preferred) : `:${fallback}`);
	const target = splitBucketValue(value);
	if (!data?.available)
		return (
			<Unavailable
				choices={
					choices.isError
						? {
								available: false,
								defaultBucket: fallback,
								reason: errorText(choices.error, "Cloudflare could not be asked."),
							}
						: data
				}
			/>
		);
	return (
		<Section title="Set up automatically (recommended)">
			<p className="text-sm text-neutral-600">
				Kite uses CF_TOKEN to create an API token that can only read and write objects in{" "}
				<strong className="font-semibold text-neutral-900">{target.bucket}</strong>, allows uploads from{" "}
				<span className="font-mono">{appOrigin()}</span> on that bucket, checks the connection and saves the keys.
			</p>
			<TokenTradeOff />
			{data.error && (
				<p className="text-sm text-amber-800" data-bucket-list-error>
					Kite could not list the buckets: {data.error}
				</p>
			)}
			{buckets.length > 1 && (
				<div className="space-y-1.5">
					<Label htmlFor="auto-bucket">The Worker&apos;s bucket</Label>
					<Select
						id="auto-bucket"
						value={value}
						containerClassName="h-10 w-full"
						onChange={(event) => setPicked(event.target.value)}
					>
						{buckets.map((bucket) => (
							<option key={bucketValue(bucket)} value={bucketValue(bucket)}>
								{bucketLabel(bucket)}
							</option>
						))}
					</Select>
					<p className="text-xs text-neutral-500">
						The bucket bound as BUCKET in wrangler.jsonc, {fallback} unless you renamed it.
					</p>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{setup.done ? (
					<Button type="button" onClick={onClose}>
						Done
					</Button>
				) : (
					<Button
						type="button"
						disabled={setup.busy}
						onClick={() => void setup.run("/cloudflare/direct-uploads", target)}
					>
						{setup.busy ? "Setting up…" : "Set up automatically"}
					</Button>
				)}
			</div>
			<SetupResult state={setup} success="Direct uploads are on. Large Drive uploads now go straight to R2." />
			{setup.error && <p className="text-sm text-neutral-600">Or follow the steps below to set it up by hand.</p>}
		</Section>
	);
}

const CLASSES: RoutableClass[] = ["drive", "backups", "mail"];

function ExistingBucket({ choices, setup }: { choices: R2Choices; setup: ReturnType<typeof useR2Setup> }) {
	const buckets = choices.buckets ?? [];
	const [picked, setPicked] = useState("");
	const value = picked || (buckets[0] ? bucketValue(buckets[0]) : "");
	if (!buckets.length)
		return (
			<p className="text-sm text-neutral-500">
				{choices.error ? `Kite could not list the buckets: ${choices.error}` : "This account has no R2 buckets yet."}
			</p>
		);
	return (
		<div className="flex flex-wrap items-end gap-2">
			<div className="min-w-48 flex-1 space-y-1.5">
				<Label htmlFor="r2-existing-bucket">Existing bucket</Label>
				<Select
					id="r2-existing-bucket"
					value={value}
					containerClassName="h-10 w-full"
					onChange={(event) => setPicked(event.target.value)}
				>
					{buckets.map((bucket) => (
						<option key={bucketValue(bucket)} value={bucketValue(bucket)}>
							{bucketLabel(bucket)}
						</option>
					))}
				</Select>
			</div>
			<Button
				type="button"
				variant="outline"
				disabled={setup.busy || !value}
				onClick={() => void setup.run("/cloudflare/buckets", { ...splitBucketValue(value), create: false })}
			>
				Connect this bucket
			</Button>
		</div>
	);
}

function NewBucket({ setup }: { setup: ReturnType<typeof useR2Setup> }) {
	const [use, setUse] = useState<RoutableClass>("drive");
	const [name, setName] = useState<string | null>(null);
	const [locationHint, setLocationHint] = useState("");
	const [jurisdiction, setJurisdiction] = useState("");
	const bucket = name ?? suggestedBucketName(use);
	const problem = r2BucketNameProblem(bucket);
	return (
		<div className="space-y-3">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="r2-new-use">For</Label>
					<Select
						id="r2-new-use"
						value={use}
						containerClassName="h-10 w-full"
						onChange={(event) => setUse(event.target.value as RoutableClass)}
					>
						{CLASSES.map((objectClass) => (
							<option key={objectClass} value={objectClass}>
								{CLASS_LABELS[objectClass]}
							</option>
						))}
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="r2-new-name">New bucket name</Label>
					<Input
						id="r2-new-name"
						value={bucket}
						spellCheck={false}
						autoCapitalize="off"
						aria-invalid={problem ? true : undefined}
						aria-describedby={problem ? "r2-new-name-error" : undefined}
						onChange={(event) => setName(event.target.value)}
					/>
					{problem && (
						<p id="r2-new-name-error" className="text-xs text-red-600">
							{problem}
						</p>
					)}
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="r2-new-location">Location</Label>
					<Select
						id="r2-new-location"
						value={locationHint}
						containerClassName="h-10 w-full"
						onChange={(event) => setLocationHint(event.target.value)}
					>
						{R2_LOCATION_HINTS.map((hint) => (
							<option key={hint.value} value={hint.value}>
								{hint.label}
							</option>
						))}
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="r2-new-jurisdiction">Jurisdiction</Label>
					<Select
						id="r2-new-jurisdiction"
						value={jurisdiction}
						containerClassName="h-10 w-full"
						onChange={(event) => setJurisdiction(event.target.value)}
					>
						<option value="">Default</option>
						<option value="eu">European Union</option>
						<option value="fedramp">FedRAMP</option>
					</Select>
				</div>
			</div>
			<Button
				type="button"
				disabled={setup.busy || !!problem}
				onClick={() => void setup.run("/cloudflare/buckets", { bucket, jurisdiction, locationHint, create: true })}
			>
				{setup.busy ? "Setting up…" : "Create bucket and connect"}
			</Button>
			{setup.code === "bucket_exists" && setup.bucket && (
				<Button
					type="button"
					variant="outline"
					disabled={setup.busy}
					onClick={() => void setup.run("/cloudflare/buckets", { bucket: setup.bucket, jurisdiction, create: false })}
				>
					Use the existing {setup.bucket}
				</Button>
			)}
		</div>
	);
}

/**
 * Add store with Cloudflare R2: create a new bucket, or connect one of the account's buckets, in one click. The form
 * below stays for keys made by hand.
 */
export function R2OneClick({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
	const choices = useR2Choices();
	const setup = useR2Setup(onSaved);
	const [mode, setMode] = useState<"new" | "existing">("new");
	const data = choices.data;
	if (!data?.available) return <Unavailable choices={choices.isError ? undefined : data} />;
	return (
		<Section title="Connect R2 in one click">
			<div role="radiogroup" aria-label="Bucket" className="flex flex-wrap gap-2">
				{(["new", "existing"] as const).map((option) => (
					<button
						key={option}
						type="button"
						role="radio"
						aria-checked={mode === option}
						onClick={() => setMode(option)}
						className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${mode === option ? "border-blue-600 bg-blue-50 text-blue-900" : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"}`}
					>
						{option === "new" ? "Create a new R2 bucket" : "Use an existing bucket"}
					</button>
				))}
			</div>
			{mode === "new" ? <NewBucket setup={setup} /> : <ExistingBucket choices={data} setup={setup} />}
			<TokenTradeOff />
			<SetupResult state={setup} success="The bucket is connected and saved as a store." />
			{setup.done && (
				<Button type="button" onClick={onClose}>
					Done
				</Button>
			)}
		</Section>
	);
}
