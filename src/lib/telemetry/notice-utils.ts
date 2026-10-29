import { SOURCE_CODE_URL } from "@/lib/source-code";
import { telemetryDayLabel } from "./telemetry-utils";
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

/** What the report is for, in the words the notice, the setup section and Admin → General share. */
export const TELEMETRY_PURPOSE =
	"so the Kite project can see how many active installs there are and which versions, setups and modules they run";

/** The details under the notice's lead sentence, on the admin pages. */
export const TELEMETRY_NOTICE_DETAIL = `Once a day, around 02:00 UTC, it would send the Kite project one small pseudonymous report ${TELEMETRY_PURPOSE}. It holds rough counts only: ranges, never exact numbers, and no names, email addresses, domains or message content. The collector does not store IP addresses. Nothing has been sent yet. Keep on starts with the next daily report; Turn off means nothing is ever sent.`;

/** The sidebar notice's second line. */
export const TELEMETRY_NOTICE_SHORT =
	"So the Kite project can see how many active installs there are and which versions, setups and modules they run. One pseudonymous daily report, rough counts only.";

/** The notice's close button: hiding it is not a choice, and the date still holds. */
export function telemetryHideLabel(startDay: string): string {
	return `Hide (statistics still start on ${telemetryDayLabel(startDay)} UTC)`;
}
