"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuthMe } from "@/hooks/use-auth-me";
import { ForwardingEmailForm } from "./forwarding-email-form";
import { MailboxSignatureForm } from "./mailbox-signature-form";
import { ProfileForm } from "./profile-form";
import { TimeZoneForm } from "./time-zone-form";

export function AccountSettings() {
	const session = useAuthMe();
	const user = session.data?.user;
	const error = session.error || session.data === null ? "Failed to load account" : null;

	if (error) {
		return <p className="py-8 text-sm text-red-600">{error}</p>;
	}

	if (!user) {
		return (
			<div className="space-y-6 py-4">
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-72 w-full rounded-3xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 py-4">
			{/* <div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Account</h1>
				<p className="mt-1 text-sm text-neutral-500">Manage your account details and sign-in password.</p>
			</div> */}

			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">Account details</h2>
					<p className="mt-1 text-sm text-neutral-500">
						Manage your identity, recovery options, and email preferences.
					</p>
				</div>
				<div className="space-y-1 overflow-hidden rounded-3xl">
					<ProfileForm initialName={user.name} initialResetEmail={user.resetEmail ?? ""} email={user.email} />

					<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />

					<div className="space-y-4 rounded-lg bg-white p-6">
						<div>
							<h3 className="text-lg font-semibold text-neutral-900">Forwarding email</h3>
							<p className="mt-1 text-sm text-neutral-500">
								Send a copy of incoming messages to another email address.
							</p>
						</div>
						<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
					</div>

					<div className="space-y-4 rounded-b-3xl rounded-t-lg bg-white p-6">
						<div>
							<h3 className="text-lg font-semibold text-neutral-900">Email signature</h3>
							<p className="mt-1 text-sm text-neutral-500">
								Configure the signature for the inbox currently selected above.
							</p>
						</div>
						<MailboxSignatureForm />
					</div>
				</div>
			</section>
		</div>
	);
}
