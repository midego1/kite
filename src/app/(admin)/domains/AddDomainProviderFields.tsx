import { LoaderCircle } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { AddDomainProviderFieldsProps, ReceivingProvider, SendingProvider } from "./types";
import { Select } from "@/components/ui/select";

function receivingHint(provider: ReceivingProvider): string {
	if (provider === "cloudflare") return "Cloudflare Email Routing is enabled on the zone.";
	if (provider === "none") return "The domain only sends. Add a receiving service later.";
	return "Add your credentials and set it up from the domain page after adding.";
}

function sendingHint(provider: SendingProvider, checking: boolean): string {
	if (checking) return "Checking Cloudflare access...";
	if (provider === "cloudflare") return "Cloudflare Email Sending is enabled on the zone.";
	if (provider === "none") return "Receive-only mode. Add a sending service later.";
	return "Add your credentials and set it up from the domain page after adding.";
}

/** The receiving and sending provider choices of the add-domain dialog. */
export default function AddDomainProviderFields({
	receivingProvider,
	onReceivingProviderChange,
	sendingProvider,
	onSendingProviderChange,
	checking,
}: AddDomainProviderFieldsProps) {
	return (
		<>
			<div className="flex items-center justify-between gap-4 rounded-lg bg-neutral-50 px-4 py-3">
				<div>
					<Label htmlFor="receiving-provider">Receive mail with</Label>
					<p className="mt-1 text-xs leading-5 text-neutral-500">{receivingHint(receivingProvider)}</p>
				</div>
				<Select
					id="receiving-provider"
					value={receivingProvider}
					onChange={(e) => onReceivingProviderChange(e.target.value as ReceivingProvider)}
					containerClassName="h-9 shrink-0"
					className="text-sm"
				>
					<option value="cloudflare">Cloudflare Email Routing</option>
					<option value="resend">Resend</option>
					<option value="ses">Amazon SES</option>
					<option value="none">Not selected</option>
				</Select>
			</div>
			<div className="flex items-center justify-between gap-4 rounded-lg bg-neutral-50 px-4 py-3">
				<div>
					<Label htmlFor="sending-provider">Send mail with</Label>
					<p className="mt-1 text-xs leading-5 text-neutral-500">{sendingHint(sendingProvider, checking)}</p>
				</div>
				{checking && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-neutral-500" />}
				<Select
					id="sending-provider"
					value={sendingProvider}
					onChange={(e) => onSendingProviderChange(e.target.value as SendingProvider)}
					containerClassName="h-9 shrink-0"
					className="text-sm"
				>
					<option value="cloudflare">Cloudflare Email Sending</option>
					<option value="resend">Resend</option>
					<option value="ses">Amazon SES</option>
					<option value="none">Not selected</option>
				</Select>
			</div>
		</>
	);
}
