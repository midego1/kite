import { markBootStep } from "@/components/boot-trace-utils";

/**
 * Names the part of the app React renders next in the boot trace (boot-trace-utils.ts), so a start that froze says
 * where: placed before a part, it records its name when React reaches it. Does nothing once the start completed.
 */
export function BootStep({ name }: { name: string }) {
	markBootStep(name);
	return null;
}
