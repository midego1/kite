import { notFound, redirect } from "next/navigation";
import MailboxesPage from "@/app/(admin)/mailboxes/page";
import MailboxSettingsPage from "@/app/(admin)/mailboxes/[id]/page";
import { canManageOwnMailboxes } from "@/app/(admin)/mailboxes/utils";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

// The list and the editor share one route so the Worker carries one route entry; the API still checks every change.
export default async function SettingsMailboxesPage({ params }: { params: Promise<{ id?: string[] }> }) {
	if (!canManageOwnMailboxes(await getCurrentUser(getEnv()))) redirect("/settings");
	const { id } = await params;
	if (!id) return <MailboxesPage />;
	if (id.length > 1) notFound();
	return <MailboxSettingsPage />;
}
