"use client";

import { AdminUpdateCard } from "@/components/admin-update-card";
import { useCurrentUser } from "@/hooks/use-current-user";

export default function AdminSettingsPage() {
	const user = useCurrentUser();

	return (
		<div>
			<div className="mb-8">
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Admin settings</h1>
				<p className="mt-2 text-sm text-neutral-500">Manage workspace-level mail infrastructure and integrations.</p>
			</div>
			{user?.isPrimaryAdmin && <AdminUpdateCard />}
		</div>
	);
}
