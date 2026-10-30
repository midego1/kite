import { PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";
import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
import { MailboxSignatureForm } from "@/components/settings/mailbox-signature-form";
import { SendingSettings } from "@/components/settings/sending-settings";

export default function SettingsComposingPage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Composing"
				description="How your mail goes out: a last look before sending, your signature and automatic replies."
			/>
			<SettingsCard>
				<SettingsCardSection
					title="Sending"
					description="Review messages before they go out and give yourself time to undo."
				>
					<SendingSettings />
				</SettingsCardSection>
				<SettingsCardSection
					title="Signature"
					description="Added to new messages from the inbox selected in the sidebar."
				>
					<MailboxSignatureForm />
				</SettingsCardSection>
				<SettingsCardSection
					title="Automatic reply"
					description="An out-of-office answer from the inbox selected in the sidebar."
				>
					<MailboxAutoReplyForm />
				</SettingsCardSection>
			</SettingsCard>
		</div>
	);
}
