"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuthMe } from "@/hooks/use-auth-me";
import { ForwardingEmailForm } from "./forwarding-email-form";
import { ProfileForm } from "./profile-form";
import { TimeZoneForm } from "./time-zone-form";
import { PageHeader, SettingsCard } from "@/components/ui/page";

export function AccountSettings() {
	const session = useAuthMe();
	const user = session.data?.user;
	const error = session.error || session.data === null ? "Failed to load account" : null;

	if (error) {
		return (
			<p role="alert" className="py-8 text-sm text-red-600">
				{error}
			</p>
		);
	}

	if (!user) {
		return (
			<div className="space-y-6 py-4">
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-72 w-full rounded-xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<PageHeader title="My account" description="Your profile, recovery email, time zone and forwarding." />

			<section className="space-y-4">
				<div>
					<h2 className="text-base font-semibold text-neutral-900">Account details</h2>
					<p className="mt-1 text-sm text-neutral-500">
						Manage your identity, recovery options, and email preferences.
					</p>
				</div>
				<SettingsCard>
					<ProfileForm initialName={user.name} initialResetEmail={user.resetEmail ?? ""} email={user.email} />

					<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />

					<div className="space-y-4 p-5">
						<div>
							<h3 className="text-sm font-semibold text-neutral-900">Forwarding email</h3>
							<p className="mt-1 text-sm text-neutral-500">
								Send a copy of incoming messages to another email address.
							</p>
						</div>
						<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
					</div>
				</SettingsCard>
			</section>
		</div>
	);
}
