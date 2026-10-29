import { SOURCE_CODE_URL } from "@/lib/source-code";
import { DEFAULT_TELEMETRY_URL, telemetryDayLabel } from "./telemetry-utils";
import type { SetupTelemetryStatus, TelemetryStatus } from "./types";

/** The privacy page's section on usage statistics, linked from setup, the notice and Admin → General. */
export const TELEMETRY_DOCS_URL = `${SOURCE_CODE_URL}/blob/main/docs/privacy.md#usage-statistics`;

/** The line under the setup switch. */
export function usageStatisticsSetupHint(input: { forcedOff: boolean; endpoint: string | null; checked: boolean }) {
	if (input.forcedOff) return "Off: turned off by the KITE_TELEMETRY setting of this deployment.";
	if (!input.endpoint) return "KITE_TELEMETRY_URL is empty or not a usable https address, so nothing is sent.";
	return input.checked
		? "On. The first report goes out at the first 02:00 UTC after setup."
		: "Off. Nothing will be sent, and no install ID is made.";
}

/** What the registration sends: the switch, or nothing under `KITE_TELEMETRY=0`, where it cannot be turned on. */
export function setupUsageStatisticsChoice(status: SetupTelemetryStatus | undefined, checked: boolean) {
	return status?.forcedOff ? undefined : checked;
}

/** Undecided, and the notice gave a start day: statistics are on by default and start that day. */
export function telemetryStartsLater(status: TelemetryStatus | null): status is TelemetryStatus & { startDay: string } {
	return Boolean(status && status.decision === null && status.startDay && !status.forcedOff);
}

/** The Admin → General switch: on when statistics are sent, or will be from the notice's start day. */
export function telemetrySwitchOn(status: TelemetryStatus | null): boolean {
	return Boolean(status?.enabled) || telemetryStartsLater(status);
}

/** Whether reports go to the Kite project's own collector, the only one whose purpose and handling the copy states. */
export function isDefaultCollector(endpoint: string | null | undefined): boolean {
	return endpoint === DEFAULT_TELEMETRY_URL;
}

/** What the Kite project's reports are for, after "so the Kite project can see": the one wording the copy shares. */
const TELEMETRY_PURPOSE =
	"how many active installs there are, which versions, runtimes and modules they run, and roughly how many accounts and mailboxes they have and use";

/** The details under the notice's lead sentence, on the admin pages, for the Kite project's collector. */
const TELEMETRY_NOTICE_DETAIL = `Once a day, around 02:00 UTC, it would send the Kite project one small pseudonymous report, so it can see ${TELEMETRY_PURPOSE}. It holds rough counts only: ranges, never exact numbers, and no names, email addresses, domains or message content. The collector does not store IP addresses. Nothing has been sent yet. Keep on starts with the next daily report; Turn off means nothing is ever sent.`;

/** The same details when `KITE_TELEMETRY_URL` sends reports to another collector: nothing is claimed about who runs it. */
const TELEMETRY_NOTICE_DETAIL_CUSTOM =
	"Once a day, around 02:00 UTC, it would send one small pseudonymous report to the collector this deployment is set up to use. It holds rough counts only: ranges, never exact numbers, and no names, email addresses, domains or message content. Nothing has been sent yet. Keep on starts with the next daily report; Turn off means nothing is ever sent.";

/** The sidebar notice's second line, for the Kite project's collector. */
const TELEMETRY_NOTICE_SHORT =
	"So the Kite project can see how many active installs there are, which versions and modules they run, and roughly how many accounts and mailboxes they have. One pseudonymous daily report, rough counts only.";

/** The sidebar notice's second line for another collector. */
const TELEMETRY_NOTICE_SHORT_CUSTOM =
	"One pseudonymous daily report, rough counts only, to the collector this deployment is set up to use.";

/** What the report is for, as the end of a sentence that starts "Kite sends one small report …". */
export function telemetryPurposeClause(endpoint: string | null | undefined): string {
	return isDefaultCollector(endpoint)
		? `so the Kite project can see ${TELEMETRY_PURPOSE}`
		: "to the collector this deployment is set up to use";
}

/** What Admin → General can say about the collector's own logging: only the Kite project's collector is described. */
export function telemetryCollectorLogging(endpoint: string | null | undefined): string {
	return isDefaultCollector(endpoint)
		? "The collector does not log or store either, but Cloudflare’s own analytics for the collector’s zone may record a sample of IP addresses."
		: "What another collector logs or stores is up to whoever runs it.";
}

/** The notice's detail and short line for where reports go (a null endpoint never shows a notice). */
export function telemetryNoticeCopy(endpoint: string | null | undefined) {
	return isDefaultCollector(endpoint)
		? { detail: TELEMETRY_NOTICE_DETAIL, short: TELEMETRY_NOTICE_SHORT }
		: { detail: TELEMETRY_NOTICE_DETAIL_CUSTOM, short: TELEMETRY_NOTICE_SHORT_CUSTOM };
}

/** The notice's close button: hiding it is not a choice, and the date still holds. */
export function telemetryHideLabel(startDay: string): string {
	return `Hide (statistics still start on ${telemetryDayLabel(startDay)} UTC)`;
}
