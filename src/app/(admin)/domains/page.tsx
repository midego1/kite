"use client";

import { mobilePrimaryActionAboveNavClass } from "@/components/page-header-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List } from "@/components/ui/list";
import { CheckCircle2, Plus } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { useAuthMe } from "@/hooks/use-auth-me";
import type {
	DnsAuthRecord,
	DnsStatusSummary,
	Domain,
	DomainDnsCache,
	DomainDnsView,
	DomainPreflight,
	ReceivingProvider,
	SendingProvider,
} from "./types";
import DomainItemCard from "./DomainItemCard";
import AddDomainProviderFields from "./AddDomainProviderFields";
import { SkipDnsSwitch } from "@/components/skip-dns-switch";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { checkDomain } from "./utils";
import { confirmMxReplacement, postJson } from "./api";
import toast from "react-hot-toast";

export default function DomainsPage() {
	const qc = useQueryClient();
	const [hostname, setHostname] = useState("");
	// Self-hosted installs without Cloudflare credentials manage DNS by hand.
	const { data: me } = useAuthMe();
	const managesDns = me?.managesDns ?? true;
	const [domainCheck, setDomainCheck] = useState<DomainPreflight | null>(null);
	const [domainChecking, setDomainChecking] = useState(false);
	const [sendingProvider, setSendingProvider] = useState<SendingProvider>("cloudflare");
	const [receivingProvider, setReceivingProvider] = useState<ReceivingProvider>("cloudflare");
	const [skipDns, setSkipDns] = useState(false);
	const [domainCheckError, setDomainCheckError] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [setupRecord, setSetupRecord] = useState<DnsAuthRecord | null>(null);
	const [setupMessage, setSetupMessage] = useState<string | null>(null);
	const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
	const expandedIdRef = useRef<string | null>(null);
	const [dnsLoading, setDnsLoading] = useState(false);
	const [dnsError, setDnsError] = useState<string | null>(null);
	const [dnsViews, setDnsViews] = useState<DomainDnsCache>({});

	const { data, isLoading } = useQuery({
		queryKey: ["domains"],
		queryFn: async () => {
			const res = await authFetch("/api/domains?includeDns=true");
			return (await res.json()) as {
				domains: Domain[];
				dns: Record<string, DnsStatusSummary>;
			};
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const normalized = hostname.toLowerCase().trim();
			if (skipDns) return postJson("/api/domains", "POST", { hostname: normalized, skipDns: true });
			let checkedDomain = domainCheck;
			if (checkedDomain?.hostname !== normalized) {
				const result = await checkDomain(normalized);
				if (!result.ok || !result.domain) {
					throw new Error(result.error ?? "Domain check failed");
				}
				checkedDomain = result.domain;
				setDomainCheck(result.domain);
			}
			if (!checkedDomain) throw new Error("Domain check failed");

			return postJson("/api/domains", "POST", {
				hostname: checkedDomain.hostname,
				enableRouting: true,
				sendingProvider,
				receivingProvider,
			});
		},
		onSuccess: () => {
			setHostname("");
			setDomainCheck(null);
			setSkipDns(false);
			setSendingProvider("cloudflare");
			setReceivingProvider("cloudflare");
			setDomainCheckError(null);
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["domains"] });
		},
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const res = await authFetch(`/api/domains/${id}`, { method: "DELETE" });
			const json = (await res.json().catch(() => ({}))) as { error?: string; completed?: boolean };
			if (!res.ok) throw new Error(json.error ?? "Failed to remove");
			if (json.completed === false)
				toast(
					"The domain's mailboxes are still being deleted. The domain disappears from this list when that finishes.",
				);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
	});

	const loadDns = async (id: string) => {
		const res = await authFetch(`/api/domains/${id}/dns`);
		const json = (await res.json()) as {
			domain?: Domain;
			dns?: DomainDnsView;
			error?: string;
		};
		if (!res.ok || !json.domain || !json.dns) {
			throw new Error(json.error ?? "Failed to load DNS");
		}
		const loadedView = { domain: json.domain, dns: json.dns };
		setDnsViews((current) => ({ ...current, [id]: loadedView }));
		if (expandedIdRef.current === id) setSetupMessage(null);
	};

	const toggleDns = async (id: string) => {
		if (expandedDomainId === id) {
			expandedIdRef.current = null;
			setExpandedDomainId(null);
			setSetupMessage(null);
			setDnsLoading(false);
			setDnsError(null);
			return;
		}
		// Expand immediately and show a skeleton while the audit is fetched, rather
		// than leaving the card unchanged until the request resolves.
		expandedIdRef.current = id;
		setExpandedDomainId(id);
		setSetupMessage(null);
		setDnsError(null);
		if (dnsViews[id]) {
			setDnsLoading(false);
			return;
		}
		setDnsLoading(true);
		try {
			await loadDns(id);
		} catch (error) {
			if (expandedIdRef.current === id) {
				setDnsError(error instanceof Error ? error.message : "Failed to load DNS");
			}
		} finally {
			if (expandedIdRef.current === id) setDnsLoading(false);
		}
	};

	const [sendingBusy, setSendingBusy] = useState(false);
	const [sendingMessage, setSendingMessage] = useState<string | null>(null);

	const changeSendingProvider = async (provider: SendingProvider) => {
		if (!expandedDomainId) return;
		const id = expandedDomainId;
		setSendingBusy(true);
		setSendingMessage(null);
		try {
			const put = async (replaceMx: boolean) => {
				const res = await authFetch(`/api/domains/${id}/sending`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ provider, replaceMx }),
				});
				return {
					res,
					json: (await res.json()) as {
						warning?: string;
						error?: string;
						code?: string;
						records?: { content: string; priority: number }[];
					},
				};
			};
			let { res, json } = await put(false);
			// Cloudflare sending refuses while another service's MX records exist.
			if (await confirmMxReplacement(res, json)) ({ res, json } = await put(true));
			if (!res.ok) throw new Error(json.error ?? "Failed to change sending provider");
			if (json.warning) setSendingMessage(json.warning);
			await loadDns(id);
			qc.invalidateQueries({ queryKey: ["domains"] });
		} catch (error) {
			setSendingMessage(error instanceof Error ? error.message : "Failed to change sending provider");
		} finally {
			setSendingBusy(false);
		}
	};

	const [receivingBusy, setReceivingBusy] = useState(false);
	const [receivingMessage, setReceivingMessage] = useState<string | null>(null);

	const changeReceivingProvider = async (provider: ReceivingProvider) => {
		if (!expandedDomainId) return;
		const id = expandedDomainId;
		setReceivingBusy(true);
		setReceivingMessage(null);
		try {
			const res = await authFetch(`/api/domains/${id}/receiving`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider }),
			});
			const json = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(json.error ?? "Failed to change receiving provider");
			await loadDns(id);
			qc.invalidateQueries({ queryKey: ["domains"] });
		} catch (error) {
			setReceivingMessage(error instanceof Error ? error.message : "Failed to change receiving provider");
		} finally {
			setReceivingBusy(false);
		}
	};

	const refreshExpandedDns = () => {
		if (!expandedDomainId) return;
		void loadDns(expandedDomainId).catch(() => undefined);
		qc.invalidateQueries({ queryKey: ["domains"] });
	};

	const setupDns = async (record: DnsAuthRecord) => {
		if (!expandedDomainId) return;
		const dnsView = dnsViews[expandedDomainId];
		if (!dnsView) return;
		setSetupRecord(record);
		setSetupMessage(null);
		try {
			const post = async (replaceMx: boolean) => {
				const res = await authFetch(`/api/domains/${dnsView.domain.id}/dns/setup`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ record, replaceMx }),
				});
				return {
					res,
					json: (await res.json()) as {
						domain?: Domain;
						dns?: DomainDnsView;
						error?: string;
						code?: string;
						records?: { content: string; priority: number }[];
					},
				};
			};
			let { res, json } = await post(false);
			if (await confirmMxReplacement(res, json)) ({ res, json } = await post(true));
			if (!res.ok) throw new Error(json.error ?? "Failed to set up DNS record");
			if (json.domain && json.dns) {
				const updatedView = { domain: json.domain, dns: json.dns };
				setDnsViews((current) => ({
					...current,
					[dnsView.domain.id]: updatedView,
				}));
			} else await loadDns(dnsView.domain.id);
			qc.invalidateQueries({ queryKey: ["domains"] });
		} catch (error) {
			setSetupMessage(error instanceof Error ? error.message : "Failed to set up DNS record");
		} finally {
			setSetupRecord(null);
		}
	};

	const inspectDomain = async () => {
		const normalized = hostname.toLowerCase().trim();
		if (skipDns || normalized.length < 3 || domainCheck?.hostname === normalized) return;

		setDomainChecking(true);
		setDomainCheckError(null);
		const result = await checkDomain(normalized);
		setDomainChecking(false);
		if (!result.ok || !result.domain) {
			setDomainCheck(null);
			setDomainCheckError(result.error ?? "Domain check failed");
			return;
		}

		setDomainCheck(result.domain);
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl md:text-3xl font-medium">Domains</h1>
					<p className="mt-1 text-sm text-neutral-500">
						{managesDns
							? "Domains must be on your Cloudflare account, which manages their DNS. Choose per domain whether Cloudflare, Resend or Amazon SES receives and sends its mail."
							: "Add the domains this server receives mail for. Open DNS on a domain to see the MX, SPF and DMARC records to create."}
					</p>
				</div>
				<Dialog open={createOpen} onOpenChange={setCreateOpen}>
					<DialogTrigger asChild>
						<Button className={mobilePrimaryActionAboveNavClass}>
							<Plus className="h-4 w-4" />
							New domain
						</Button>
					</DialogTrigger>
					<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>Add domain</DialogTitle>
							<DialogDescription>
								Connect a Cloudflare zone, then choose which service receives its mail and whether Kite should provision
								Email Sending.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="hostname">Hostname</Label>
								<Input
									id="hostname"
									value={hostname}
									onChange={(e) => {
										setHostname(e.target.value);
										if (domainCheck?.hostname !== e.target.value.toLowerCase().trim()) {
											setDomainCheck(null);
										}
									}}
									onBlur={() => void inspectDomain()}
									placeholder="example.com"
								/>
							</div>
							<SkipDnsSwitch
								id="skip-dns"
								checked={skipDns}
								onCheckedChange={(checked) => {
									setSkipDns(checked);
									setDomainCheckError(null);
									create.reset();
								}}
								disabled={create.isPending}
							/>
							{!skipDns && (
								<AddDomainProviderFields
									receivingProvider={receivingProvider}
									onReceivingProviderChange={setReceivingProvider}
									sendingProvider={sendingProvider}
									onSendingProviderChange={setSendingProvider}
									checking={domainChecking}
								/>
							)}
							{domainCheck && !skipDns && (
								<div className="flex items-center gap-3 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
									<CheckCircle2 className="h-4 w-4" />
									Domain found in Cloudflare as {domainCheck.zone.name}
								</div>
							)}
							{domainCheckError && (
								<p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
									{domainCheckError}
								</p>
							)}
							{create.isError && (
								<div role="alert" className="space-y-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
									<p>{(create.error as Error).message}</p>
									<div className={skipDns ? "hidden" : "space-y-2"}>
										<p className="font-medium">Check that your Cloudflare API token has these permissions:</p>
										<ul className="list-disc space-y-1 pl-5">
											<li>
												All accounts — DNS Settings:Edit, Email Routing Addresses:Edit; Email Sending:Edit for outbound
												mail
											</li>
											<li>All zones — DNS Settings:Edit, Email Routing Rules:Edit, Zone Settings:Edit, DNS:Edit</li>
										</ul>
									</div>
								</div>
							)}
							<Button
								onClick={() => create.mutate()}
								disabled={!hostname || (domainChecking && !skipDns) || create.isPending}
							>
								{create.isPending ? "Adding..." : "Add domain"}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			</div>
			<section className="space-y-3">
				{/* <div className="flex items-center justify-between">
					<span className="text-sm text-neutral-500">{(data?.domains ?? []).length} total</span>
				</div> */}
				{isLoading && <SectionRowSkeleton />}
				{!isLoading && (data?.domains ?? []).length === 0 && (
					<p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">No domains yet</p>
				)}
				<List>
					{(data?.domains ?? []).map((d) => {
						const dns = data?.dns?.[d.id];
						return (
							<DomainItemCard
								key={d.id}
								dns={dns}
								dnsDetails={dnsViews[d.id]?.dns}
								onSendingProviderChange={changeSendingProvider}
								sendingProviderBusy={sendingBusy}
								sendingProviderMessage={expandedDomainId === d.id ? sendingMessage : null}
								onReceivingProviderChange={changeReceivingProvider}
								receivingProviderBusy={receivingBusy}
								receivingProviderMessage={expandedDomainId === d.id ? receivingMessage : null}
								onDnsChanged={refreshExpandedDns}
								dnsLoading={expandedDomainId === d.id && dnsLoading}
								dnsError={expandedDomainId === d.id ? dnsError : null}
								expanded={expandedDomainId === d.id}
								onToggleDns={toggleDns}
								onSetup={setupDns}
								setupRecord={setupRecord}
								setupMessage={setupMessage}
								item={d}
								managesDns={managesDns}
								remove={remove}
							/>
						);
					})}
				</List>
			</section>
		</div>
	);
}
