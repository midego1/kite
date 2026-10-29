import { PageHeader, PageSection, SettingsCard, SettingsCardSection } from "@/components/ui/page";
import { InboxThreadingSettings } from "@/components/settings/inbox-threading-settings";
import { LayoutSyncSetting } from "@/components/settings/layout-sync-setting";
import { RecipientAddressSettings } from "@/components/settings/recipient-address-settings";
import { RemoteImageSettings } from "@/components/settings/remote-image-settings";
import { SendingSettings } from "@/components/settings/sending-settings";
import { InboxShortcutsSettings } from "@/components/settings/inbox-shortcuts-settings";
import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
import { SpamFilterSettings } from "@/components/settings/spam-filter-settings";
import { ScreenerSettings } from "@/components/settings/screener-settings";
import { TrashRetentionSettings } from "@/components/settings/trash-retention-settings";
import { BrowserNotificationSettings } from "@/components/settings/browser-notification-settings";

export default function SettingsInboxPage() {
	return (
		<div className="space-y-8">
			<PageHeader
				title="Inbox settings"
				description="How you read, send and sort mail, and what happens to new mail before you see it."
			/>
			<PageSection title="Inbox experience" description="Choose how you read and interact with email.">
				<SettingsCard>
					<SettingsCardSection title="Threading" description="Choose how emails are organized in your inbox.">
						<InboxThreadingSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Layout" description="Choose whether your layout follows your account.">
						<LayoutSyncSetting />
					</SettingsCardSection>
					<SettingsCardSection
						title="Addresses"
						description="Choose how recipient addresses appear when you read mail."
					>
						<RecipientAddressSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Privacy" description="Choose whether messages load images from other servers.">
						<RemoteImageSettings />
					</SettingsCardSection>
					<SettingsCardSection
						title="Sending"
						description="Review messages before they go out and give yourself time to undo."
					>
						<SendingSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Shortcuts" description="Choose whether keyboard shortcuts are active.">
						<InboxShortcutsSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Notifications" description="Choose how you hear about new email.">
						<BrowserNotificationSettings />
					</SettingsCardSection>
				</SettingsCard>
			</PageSection>
			<PageSection
				title="Message handling"
				description="Manage the Screener, spam protection, clean-up and automatic replies."
			>
				<SettingsCard>
					<SettingsCardSection
						title="Screener"
						description="Decide who can reach the inbox selected above the first time they write."
					>
						<ScreenerSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Spam protection" description="Control local spam analysis for incoming messages.">
						<SpamFilterSettings />
					</SettingsCardSection>
					<SettingsCardSection
						title="Trash and Spam clean-up"
						description="Choose how long deleted and spam messages are kept."
					>
						<TrashRetentionSettings />
					</SettingsCardSection>
					<SettingsCardSection
						title="Automatic response"
						description="Configure the subject and message for the inbox currently selected above."
					>
						<MailboxAutoReplyForm />
					</SettingsCardSection>
				</SettingsCard>
			</PageSection>
		</div>
	);
}
