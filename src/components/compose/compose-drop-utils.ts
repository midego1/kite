import type { ClipboardPayload, DragPayload } from "./compose-drop-types";

/** True when a drag carries files from the desktop. `types` is an array in current browsers and a DOMStringList in old ones. */
export function dragHasFiles(transfer: DragPayload | null | undefined): boolean {
	if (!transfer) return false;
	if (Array.from(transfer.types ?? []).includes("Files")) return true;
	return Array.from(transfer.items ?? []).some((item) => item.kind === "file");
}

/** The files of a clipboard or drag, from `files` or, where a browser fills only `items`, from the file items. */
function transferFiles(transfer: ClipboardPayload | null | undefined): File[] {
	if (!transfer) return [];
	const listed = Array.from(transfer.files ?? []);
	if (listed.length > 0) return listed;
	const files: File[] = [];
	for (const item of Array.from(transfer.items ?? [])) {
		const file = item.kind === "file" ? item.getAsFile() : null;
		if (file) files.push(file);
	}
	return files;
}

/**
 * The files a paste should attach; empty when the paste is text. A copy from a page or a spreadsheet carries its
 * text next to a picture of it (`text/html` and `text/plain`), and the text is what the sender meant. A screenshot,
 * an image copied from a page without text and a file copied in the file manager (which also puts its name on the
 * clipboard as text) carry no such pair.
 */
export function pastedFiles(transfer: ClipboardPayload | null | undefined): File[] {
	const files = transferFiles(transfer);
	if (files.length === 0 || !transfer) return [];
	const types = Array.from(transfer.types ?? []);
	const hasText = transfer.getData("text/plain").trim() !== "";
	return hasText && types.includes("text/html") ? [] : files;
}

const GENERIC_IMAGE_NAME = /^(image|unnamed|untitled|clipboard)?(\s*\(\d+\))?(\.[a-z0-9]+)?$/i;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function extensionOf(file: File): string {
	const dot = file.name.lastIndexOf(".");
	if (dot > 0 && dot < file.name.length - 1) return file.name.slice(dot).toLowerCase();
	const subtype = file.type.split("/")[1]?.split(/[+;]/)[0];
	if (subtype === "jpeg") return ".jpg";
	return subtype && /^[a-z0-9]+$/i.test(subtype) ? `.${subtype.toLowerCase()}` : ".png";
}

/** `name` unless `taken` has it, then `name-2`, `name-3` before the extension. Names compare without regard to case. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let candidate = name;
	for (let count = 2; taken.has(candidate.toLowerCase()); count += 1) candidate = `${base}-${count}${extension}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

/**
 * Browsers name a pasted screenshot "image.png" (or nothing at all). It gets a dated name instead, `screenshot-YYYY-MM-DD-HHmm.png`, in
 * the viewer's local time. A file with a name of its own keeps it. A name that an attachment already has (`existing`, or an
 * earlier file of the same paste) gets `-2`, `-3`, so two pastes in the same minute never collide.
 */
export function namePastedFiles(files: File[], existing: Iterable<string> = [], now: Date = new Date()): File[] {
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	const taken = new Set(Array.from(existing, (name) => name.toLowerCase()));
	return files.map((file) => {
		const generic = file.type.startsWith("image/") && GENERIC_IMAGE_NAME.test(file.name);
		const wanted = generic ? `screenshot-${stamp}${extensionOf(file)}` : file.name;
		const name = uniqueName(wanted, taken);
		return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
	});
}
