import { PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";
import { BrowserNotificationSettings } from "@/components/settings/browser-notification-settings";

export default function SettingsNotificationsPage() {
	return (
		<div className="space-y-6">
			<PageHeader title="Notifications" description="How this browser tells you about new mail." />
			<SettingsCard>
				<SettingsCardSection
					title="Browser notifications"
					description="Shown while Kite is open in a background tab. Saved in this browser."
				>
					<BrowserNotificationSettings />
				</SettingsCardSection>
			</SettingsCard>
		</div>
	);
}
