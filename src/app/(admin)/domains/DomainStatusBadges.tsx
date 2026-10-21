import { AlertTriangle, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Domain } from "./types";

export function StatusIcon({ ok, className }: { ok: boolean; className?: string }) {
	if (ok) return <Check className={cn(className, "text-green-600")} />;
	return <AlertTriangle className={cn(className, "text-amber-500")} />;
}

function ReceivingBadge({ item }: { item: Domain }) {
	if (item.receivingProvider === "cloudflare") {
		return (
			<Badge
				variant={item.routingEnabled ? "outline" : "secondary"}
				className={cn("gap-1", !item.routingEnabled && "opacity-50")}
			>
				<StatusIcon ok={item.routingEnabled} className="h-3 w-3" />
				routing
			</Badge>
		);
	}
	if (item.receivingProvider === "none") {
		// A skipped domain has no provider yet; "sending only" would read as a choice.
		if (item.dnsSkipped) return null;
		return (
			<Badge variant="secondary" className="gap-1 opacity-50">
				sending only
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="gap-1">
			receiving via {item.receivingProvider === "ses" ? "Amazon SES" : "Resend"}
		</Badge>
	);
}

function SendingBadge({ item }: { item: Domain }) {
	if (item.sendingProvider === "resend" || item.sendingProvider === "ses") {
		return (
			<Badge variant="outline" className="gap-1">
				<StatusIcon ok className="h-3 w-3" />
				sending via {item.sendingProvider === "ses" ? "Amazon SES" : "Resend"}
			</Badge>
		);
	}
	if (item.sendingProvider === "none") {
		if (item.dnsSkipped) return null;
		return (
			<Badge variant="secondary" className="gap-1 opacity-50">
				receiving only
			</Badge>
		);
	}
	return (
		<Badge
			variant={item.sendingEnabled ? "outline" : "secondary"}
			className={cn("gap-1", !item.sendingEnabled && "opacity-50")}
		>
			<StatusIcon ok={item.sendingEnabled} className="h-3 w-3" />
			sending
		</Badge>
	);
}

/** The status, DNS-skipped and provider badges under a domain's hostname. */
export default function DomainStatusBadges({ item }: { item: Domain }) {
	return (
		<div className="flex flex-wrap gap-2">
			<Badge variant={item.status === "active" ? "success" : "secondary"} className="gap-1">
				<StatusIcon ok={item.status === "active"} className="h-3 w-3" />
				{item.status}
			</Badge>
			{item.dnsSkipped && (
				<Badge
					variant="secondary"
					className="gap-1 bg-amber-50 text-amber-900"
					title="Kite has not checked or changed this domain's DNS"
				>
					<AlertTriangle className="h-3 w-3 text-amber-600" />
					DNS skipped
				</Badge>
			)}
			<ReceivingBadge item={item} />
			<SendingBadge item={item} />
		</div>
	);
}
