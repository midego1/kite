import { EmailClientsSettings } from "@/components/settings/email-clients-settings";
import { PageHeader } from "@/components/ui/page";

export default function EmailAppsSettingsPage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="App passwords"
				description="Use your mail from a desktop or mobile app that supports JMAP. Point the app at this server and sign in with your email address and an app password."
			/>
			<EmailClientsSettings />
		</div>
	);
}
