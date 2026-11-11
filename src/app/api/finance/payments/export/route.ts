import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { MIGRATION_PENDING_ERROR } from "@/lib/finance/errors";
import { paymentsCsv } from "@/lib/finance/payment-csv-utils";
import { parsePaymentFilter } from "@/lib/finance/payment-filter-utils";
import { exportFilename } from "@/lib/finance/payment-export-utils";
import { paymentsForExport } from "@/lib/finance/payment-views";
import { withModule } from "@/lib/modules/route-guard";

/** `GET /api/finance/payments/export`: the Payments tab as CSV, narrowed by the tab's filters (spec §27.4). */
export const GET = withModule("finance", async (request, { checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const parsed = parsePaymentFilter(new URL(request.url).searchParams);
	if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const exported = await paymentsForExport(user.id, parsed.filter);
	if (!exported) return NextResponse.json({ error: MIGRATION_PENDING_ERROR }, { status: 409 });
	return new NextResponse(paymentsCsv(exported.rows), {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${exportFilename(parsed.filter, new Date())}"`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...(exported.truncated ? { "X-Kite-Export-Truncated": "1" } : {}),
		},
	});
});
