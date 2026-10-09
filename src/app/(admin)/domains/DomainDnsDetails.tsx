import { Button } from "@/components/ui/button";
import { dnsAuthDescriptions, getDnsAuthItemClass } from "./utils";
import { ROW_GRID, StatusBadge, StatusRow } from "./status-row";
import CloudflareReceivingConfig from "./CloudflareReceivingConfig";
import ReceivingSetupSection from "./ReceivingSetupSection";
import SendingSetupSection from "./SendingSetupSection";
import type { DnsAuthRecord, DomainDnsDetailsProps } from "./types";

export default function DomainDnsDetails({
	domain,
	dns,
	onSetup,
	setupRecord,
	setupMessage,
	onSendingProviderChange,
	sendingProviderBusy,
	sendingProviderMessage,
	onReceivingProviderChange,
	receivingProviderBusy,
	receivingProviderMessage,
	onDnsChanged,
}: DomainDnsDetailsProps) {
	const audit = dns.audit;
	const manual = domain.zoneId === "manual";
	const subdomain = dns.sendingSubdomain;
	const sendingOk = subdomain ? dns.sendingEnabled : manual && domain.sendingEnabled;
	const sendingLabel = subdomain
		? `Sending for ${subdomain.name} is ${dns.sendingEnabled ? "enabled" : "disabled"}`
		: manual
			? domain.sendingEnabled
				? "Email sending is configured"
				: "Email sending is not configured"
			: "Sending has not configured for this domain";
	const routingOk = dns.routing.missing.length === 0 && (dns.routing.records.length > 0 || domain.routingEnabled);
	const routingLabel = routingOk
		? "Email routing is configured"
		: dns.routing.missing.length > 0
			? `${dns.routing.missing.length} DNS record${dns.routing.missing.length === 1 ? "" : "s"} missing`
			: "No routing DNS records found";

	const auditRow = (record: DnsAuthRecord) => {
		if (!audit) return null;
		const item = audit[record];
		const ok = item.status === "ok";
		return (
			<li key={record} className={`${ROW_GRID} ${getDnsAuthItemClass(item.status)}`}>
				<StatusBadge ok={ok} tone={item.status === "missing" ? "red" : "neutral"} />
				<span className="min-w-0">
					<span className="block font-medium text-neutral-900">{item.label} record</span>
					<span className="block text-xs text-neutral-500">{dnsAuthDescriptions[record]}</span>
				</span>
				{ok ? (
					<span className="min-w-0 break-all text-neutral-500">
						{item.found.length > 0 ? item.found.join(", ") : item.name}
					</span>
				) : (
					<Button
						variant="outline"
						size="sm"
						className="shrink-0 bg-white"
						disabled={manual || setupRecord === record}
						title={manual ? "DNS for this domain is managed manually" : `Create the ${item.label} record`}
						onClick={() => onSetup?.(record)}
					>
						{setupRecord === record ? "Setting up..." : "Setup"}
					</Button>
				)}
			</li>
		);
	};

	const cloudflareConfig = (
		<ul className="space-y-2">
			<StatusRow ok={!!sendingOk} title="Email Sending" hint="Sends outgoing email from this domain">
				{sendingLabel}
			</StatusRow>
			{auditRow("dkim")}
		</ul>
	);

	const cloudflareReceiving = (
		<CloudflareReceivingConfig
			domainId={domain.id}
			routingOk={routingOk}
			routingLabel={routingLabel}
			manual={manual}
			onChanged={onDnsChanged}
		/>
	);

	return (
		<div className="px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
			{audit && (
				<section>
					<h2 className="text-base font-semibold text-neutral-900">Domain setup</h2>
					<p className="mt-0.5 text-sm text-neutral-500">
						Review the DNS authentication that keeps mail deliverable, whichever services send and receive it.
					</p>
					<ul className="mt-3 space-y-2">{(["mx", "spf", "dmarc"] as DnsAuthRecord[]).map(auditRow)}</ul>
					{manual && (
						<p className="text-xs text-neutral-500">
							DNS is managed manually for this domain, so records must be created where the domain&apos;s nameservers
							are hosted.
						</p>
					)}
					{setupMessage && <p className="text-xs text-red-600">{setupMessage}</p>}
				</section>
			)}
			<ReceivingSetupSection
				domain={domain}
				onChange={onReceivingProviderChange}
				busy={receivingProviderBusy}
				message={receivingProviderMessage}
				cloudflareConfig={cloudflareReceiving}
				cloudflareOk={routingOk}
			/>
			<SendingSetupSection
				domain={domain}
				onChange={onSendingProviderChange}
				busy={sendingProviderBusy}
				message={sendingProviderMessage}
				cloudflareConfig={cloudflareConfig}
				cloudflareOk={!!sendingOk && audit?.dkim.status === "ok"}
			/>
		</div>
	);
}
