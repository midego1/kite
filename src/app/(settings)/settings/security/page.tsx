import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { MfaSettings } from "@/components/settings/mfa-settings";
import { PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";

export default function SecuritySettingsPage() {
	return (
		<div className="space-y-6">
			<PageHeader title="Security" description="How you sign in to your account." />
			<SettingsCard>
				<SettingsCardSection title="Password" description="Use at least 8 characters for your new password.">
					<ChangePasswordForm />
				</SettingsCardSection>
				<SettingsCardSection
					title="Two-factor authentication"
					description="Require a code from an authenticator app when signing in."
				>
					<MfaSettings />
				</SettingsCardSection>
			</SettingsCard>
		</div>
	);
}
