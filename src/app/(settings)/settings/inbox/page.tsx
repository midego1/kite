import { PageHeader, PageSection, SettingRows, SettingsCard, SettingsCardSection } from "@/components/ui/page";
import { InboxThreadingSettings } from "@/components/settings/inbox-threading-settings";
import { LayoutSyncSetting } from "@/components/settings/layout-sync-setting";
import { RecipientAddressSettings } from "@/components/settings/recipient-address-settings";
import { RemoteImageSettings } from "@/components/settings/remote-image-settings";
import { InboxShortcutsSettings } from "@/components/settings/inbox-shortcuts-settings";
import { SpamFilterSettings } from "@/components/settings/spam-filter-settings";
import { ScreenerSettings } from "@/components/settings/screener-settings";
import { TrashRetentionSettings } from "@/components/settings/trash-retention-settings";

export default function SettingsInboxPage() {
	return (
		<div className="space-y-8">
			<PageHeader
				title="Inbox settings"
				description="How you read and sort mail, and what happens to new mail before you see it."
			/>
			<PageSection title="Reading" description="How messages are listed and shown.">
				<SettingsCard>
					<SettingsCardSection title="Conversations">
						<InboxThreadingSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Layout and reading">
						<SettingRows>
							<LayoutSyncSetting />
							<RecipientAddressSettings />
							<RemoteImageSettings />
							<InboxShortcutsSettings />
						</SettingRows>
					</SettingsCardSection>
				</SettingsCard>
			</PageSection>
			<PageSection
				title="New mail"
				description="Who reaches the inbox, what counts as spam, and how long Trash and Spam keep mail."
			>
				<SettingsCard>
					<SettingsCardSection
						title="Screener"
						description="Decide who can reach the inbox selected in the sidebar the first time they write."
					>
						<ScreenerSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Spam protection">
						<SpamFilterSettings />
					</SettingsCardSection>
					<SettingsCardSection title="Trash and Spam clean-up">
						<TrashRetentionSettings />
					</SettingsCardSection>
				</SettingsCard>
			</PageSection>
		</div>
	);
}
