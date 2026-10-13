import { redirect } from "next/navigation";
import { hrefForModule } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

// Import is a module; Export is core, so the old combined page falls back to it.
export default async function SettingsImportExportRedirectPage() {
	redirect(await hrefForModule("import", "/settings/import", "/settings/export"));
}
