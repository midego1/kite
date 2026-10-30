"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuthMe } from "@/hooks/use-auth-me";
import { ForwardingEmailForm } from "./forwarding-email-form";
import { ProfileForm } from "./profile-form";
import { TimeZoneForm } from "./time-zone-form";
import { FormError, PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";

export function AccountSettings() {
	const session = useAuthMe();
	const user = session.data?.user;
	const error = session.error || session.data === null ? "Failed to load account" : null;

	if (error) return <FormError className="py-8">{error}</FormError>;

	if (!user) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-72 w-full rounded-xl" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<PageHeader title="My account" description="Your profile, recovery email, time zone and forwarding." />
			<SettingsCard>
				<ProfileForm initialName={user.name} initialResetEmail={user.resetEmail ?? ""} email={user.email} />
				<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />
				<SettingsCardSection
					title="Forwarding"
					description="Send a copy of incoming messages to another email address."
				>
					<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
				</SettingsCardSection>
			</SettingsCard>
		</div>
	);
}
