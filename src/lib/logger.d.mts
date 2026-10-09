export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = Record<LogLevel, (event: string, fields?: Record<string, unknown>) => void>;
export function createLogger(
	component: string,
	options?: { level?: LogLevel; sink?: (line: string, level: string) => void },
): Logger;
