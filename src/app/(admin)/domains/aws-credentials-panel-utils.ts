import type { AwsCapabilityReport } from "@/lib/aws/aws-types";

export type RefusedAwsSave = { report: AwsCapabilityReport; policy: unknown };

function isCapabilityReport(value: unknown): value is AwsCapabilityReport {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as AwsCapabilityReport).missing) &&
		(value as AwsCapabilityReport).missing.every((item) => typeof item === "string")
	);
}

/**
 * The capability report and IAM policy from the body of a refused credentials
 * save, or null when the refusal was for another reason (bad key, bad region).
 */
export function refusedAwsSave(body: unknown): RefusedAwsSave | null {
	if (!body || typeof body !== "object") return null;
	const { report, policy } = body as { report?: unknown; policy?: unknown };
	return isCapabilityReport(report) ? { report, policy: policy ?? null } : null;
}

/**
 * The report whose missing permissions the panel lists. A refused save leaves
 * the form open with nothing configured, so its report is shown on its own;
 * otherwise only saved credentials that are not being replaced have one.
 */
export function missingPermissionsReport({
	refused,
	report,
	configured,
	editing,
}: {
	refused: AwsCapabilityReport | null;
	report: AwsCapabilityReport | null;
	configured: boolean;
	editing: boolean;
}): AwsCapabilityReport | null {
	const shown = refused ?? (configured && !editing ? report : null);
	return shown && shown.missing.length > 0 ? shown : null;
}
