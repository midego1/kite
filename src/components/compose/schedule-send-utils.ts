import type { ScheduleSendOption } from "./schedule-send-types";
import {
	dateFromZonedFields,
	formatUserDate,
	formatUserDateTimeLocal,
	getUserTimeZone,
	parseUserDateTimeLocal,
	zonedDateFields,
} from "@/lib/time/utils";
import { t } from "@/lib/i18n/translator";

function atTime(date: Date, hours: number): Date {
	const fields = new Date(date);
	fields.setUTCHours(hours, 0, 0, 0);
	return dateFromZonedFields(fields, getUserTimeZone());
}

export function getScheduleSendOptions(now = new Date()): ScheduleSendOption[] {
	const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000);
	const today = zonedDateFields(now, getUserTimeZone());
	const tomorrow = new Date(today);
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	const monday = new Date(today);
	const daysUntilMonday = (8 - monday.getUTCDay()) % 7 || 7;
	monday.setUTCDate(monday.getUTCDate() + daysUntilMonday);

	return [
		{
			label:
				zonedDateFields(laterToday, getUserTimeZone()).toISOString().slice(0, 10) === today.toISOString().slice(0, 10)
					? t("Later today")
					: t("In 3 hours"),
			value: laterToday,
		},
		{ label: t("Tomorrow morning"), value: atTime(tomorrow, 8) },
		{ label: t("Monday morning"), value: atTime(monday, 8) },
	];
}

export function formatScheduledSend(value: Date): string {
	return formatUserDate(value, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatDateTimeLocal(value: Date): string {
	return formatUserDateTimeLocal(value);
}

export function parseDateTimeLocal(value: string): Date | null {
	return parseUserDateTimeLocal(value);
}
