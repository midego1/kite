"use client";

import { mobilePrimaryActionAboveNavClass } from "@/components/page-header-utils";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { useModules } from "@/components/modules/modules-context";
import type { Webhook, WebhookEvent } from "./types";
import { createWebhook, deleteWebhook, fetchWebhooks, testWebhook, updateWebhook } from "./utils";
import { WebhookDeliveries } from "./deliveries";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Checkbox } from "@/components/ui/checkbox";

export default function WebhooksPage() {
	const qc = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [description, setDescription] = useState("");
	const [maxAttempts, setMaxAttempts] = useState(5);
	const [picked, setPicked] = useState<WebhookEvent[] | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<Record<string, string>>({});

	const { modules } = useModules();
	// The catalog depends on the viewer's modules, so a change to them must not reuse a cached list.
	const webhooks = useQuery({ queryKey: ["webhooks", modules], queryFn: fetchWebhooks });
	const invalidate = () => qc.invalidateQueries({ queryKey: ["webhooks"] });
	const hooks = webhooks.data?.webhooks;
	const pickable = webhooks.data?.eventCatalog ?? [];
	const pickableValues = pickable.map((event) => event.value);
	const events = (picked ?? pickableValues).filter((value) => pickableValues.includes(value));

	const create = useMutation({
		mutationFn: () => createWebhook({ url, description: description || undefined, events, maxAttempts }),
		onSuccess: (result) => {
			setSecret(result.secret);
			setUrl("");
			setDescription("");
			setPicked(null);
			setError(null);
			setDialogOpen(false);
			invalidate();
		},
		onError: (e: Error) => setError(e.message),
	});

	const toggle = useMutation({
		mutationFn: (hook: Webhook) => updateWebhook(hook.id, { enabled: !hook.enabled }),
		onSuccess: invalidate,
	});
	const rotate = useMutation({
		mutationFn: (id: string) => updateWebhook(id, { rotateSecret: true }),
		onSuccess: (result) => {
			setSecret(result.secret ?? null);
			setError(null);
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const remove = useMutation({ mutationFn: deleteWebhook, onSuccess: invalidate });

	const runTest = useMutation({
		mutationFn: testWebhook,
		onSuccess: (result, id) => {
			setTestResult((prev) => ({ ...prev, [id]: result.status }));
			invalidate();
		},
		onError: (e: Error, id) => setTestResult((prev) => ({ ...prev, [id]: e.message })),
	});

	function toggleEvent(event: WebhookEvent) {
		setPicked(events.includes(event) ? events.filter((e) => e !== event) : [...events, event]);
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Webhooks"
				description="Deliver mail and module events to your own endpoints, with automatic retries."
				actions={
					<Button
						className={mobilePrimaryActionAboveNavClass}
						onClick={() => {
							setError(null);
							setDialogOpen(true);
						}}
					>
						<Plus className="h-4 w-4" /> Add endpoint
					</Button>
				}
			/>

			{secret && (
				<Card>
					<CardContent className="p-0 text-sm">
						<p className="font-medium">Signing secret — shown once</p>
						<p className="mt-1 text-neutral-500">
							Verify the <code>X-Email-Platform-Signature</code> header (HMAC-SHA256 of the raw body) with this secret.
						</p>
						<code className="mt-2 block break-all rounded-lg bg-neutral-100 p-2 text-xs">{secret}</code>
						<Button variant="outline" size="sm" className="mt-3" onClick={() => setSecret(null)}>
							Dismiss
						</Button>
					</CardContent>
				</Card>
			)}
			{error && !dialogOpen && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}

			{webhooks.isLoading ? (
				<SectionRowSkeleton />
			) : !hooks?.length ? (
				<EmptyState icon={WebhookIcon} title="No endpoints yet" description="Add one to start receiving events." />
			) : (
				<section className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
					{hooks.map((hook) => (
						<div key={hook.id} className="px-5 py-6 sm:px-6">
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0 flex-1">
									<h2 className="truncate text-base font-semibold text-neutral-900">{hook.url}</h2>
									{hook.description && <p className="mt-1 text-sm text-neutral-500">{hook.description}</p>}
									<div className="mt-3 flex flex-wrap gap-1.5">
										{hook.events.map((event) => (
											<Badge key={event} variant="secondary">
												{event}
											</Badge>
										))}
									</div>
								</div>
								<div className="flex items-center gap-2 rounded-full">
									<span className="text-xs font-medium text-neutral-600">{hook.enabled ? "Enabled" : "Disabled"}</span>
									<Switch
										checked={hook.enabled}
										onCheckedChange={() => toggle.mutate(hook)}
										aria-label={`${hook.enabled ? "Disable" : "Enable"} ${hook.url}`}
									/>
								</div>
							</div>
							<div className="mt-5 grid grid-cols-2 overflow-hidden rounded-xl bg-neutral-50 sm:grid-cols-5">
								<div className="px-4 py-3">
									<span className="block text-lg font-semibold text-neutral-900">{hook.stats.total}</span>
									<span className="block text-xs text-neutral-500">Deliveries</span>
								</div>
								<div className="px-4 py-3">
									<span
										className={`block text-lg font-semibold ${hook.stats.delivered ? "text-green-600" : "text-neutral-500"}`}
									>
										{hook.stats.delivered}
									</span>
									<span className="block text-xs text-neutral-500">Delivered</span>
								</div>
								<div className="px-4 py-3">
									<span
										className={`block text-lg font-semibold ${hook.stats.pending ? "text-amber-600" : "text-neutral-500"}`}
									>
										{hook.stats.pending}
									</span>
									<span className="block text-xs text-neutral-500">In flight</span>
								</div>
								<div className="px-4 py-3">
									<span
										className={`block text-lg font-semibold ${hook.stats.failing ? "text-red-600" : "text-neutral-500"}`}
									>
										{hook.stats.failing}
									</span>
									<span className="block text-xs text-neutral-500">Failed</span>
								</div>
								<div className="px-4 py-3">
									<span className="block text-lg font-semibold text-neutral-500">{hook.maxAttempts}</span>
									<span className="block text-xs text-neutral-500">Max attempts</span>
								</div>
							</div>

							<div className="mt-4 flex flex-wrap items-center gap-3">
								<Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}>
									<Activity className="h-4 w-4" />
									{expanded === hook.id ? "Hide delivery history" : "Delivery history"}
								</Button>
								<div className="ml-auto flex flex-wrap items-center gap-2">
									{testResult[hook.id] && (
										<p className="mr-1 text-sm text-neutral-600">
											Test delivery: <span className="font-medium">{testResult[hook.id]}</span>
										</p>
									)}
									<Button
										variant="ghost"
										size="sm"
										onClick={() => runTest.mutate(hook.id)}
										disabled={runTest.isPending}
									>
										<Send className="h-4 w-4" /> Test
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={async () => {
											if (
												await requestConfirmation({
													title: "Rotate this signing secret?",
													description: "The previous secret will stop signing new deliveries immediately.",
													confirmLabel: "Rotate secret",
												})
											)
												rotate.mutate(hook.id);
										}}
										disabled={rotate.isPending}
									>
										<RefreshCw className="h-4 w-4" /> Rotate secret
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={async () => {
											if (
												!(await requestConfirmation({
													title: "Delete this webhook?",
													description: `The webhook for ${hook.url} will stop receiving events immediately.`,
													confirmLabel: "Delete webhook",
												}))
											)
												return;
											remove.mutate(hook.id);
										}}
										aria-label={`Delete ${hook.url}`}
									>
										<Trash2 className="h-4 w-4" /> Delete
									</Button>
								</div>
							</div>

							{expanded === hook.id && (
								<div className="mt-4">
									<WebhookDeliveries webhookId={hook.id} />
								</div>
							)}
						</div>
					))}
				</section>
			)}

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Add endpoint</DialogTitle>
						<DialogDescription>Failed deliveries retry automatically with exponential backoff.</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							create.mutate();
						}}
					>
						<div className="space-y-2">
							<Label htmlFor="hook-url">Endpoint URL</Label>
							<Input id="hook-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
						</div>
						<div className="space-y-2">
							<Label htmlFor="hook-description">Description</Label>
							<Input
								id="hook-description"
								value={description}
								placeholder="Optional"
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Events</Label>
							{pickable.map((event) => (
								<label
									key={event.value}
									className="flex cursor-pointer items-center justify-between rounded-lg border border-neutral-200 px-3 py-2"
								>
									<span>
										<span className="block text-sm font-medium">{event.label}</span>
										<span className="block text-xs text-neutral-500">{event.hint}</span>
									</span>
									<Checkbox checked={events.includes(event.value)} onChange={() => toggleEvent(event.value)} />
								</label>
							))}
						</div>
						<div className="space-y-2">
							<Label htmlFor="hook-attempts">Max attempts</Label>
							<Input
								id="hook-attempts"
								type="number"
								min={1}
								max={10}
								value={maxAttempts}
								onChange={(e) => setMaxAttempts(Number(e.target.value))}
							/>
						</div>

						{error && (
							<p role="alert" className="text-sm text-red-600">
								{error}
							</p>
						)}

						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={create.isPending || events.length === 0}>
								<RefreshCw className={create.isPending ? "h-4 w-4 animate-spin" : "hidden"} />
								Create
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
