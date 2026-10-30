/**
 * postal-mime 2.7's `MimeNode.decodeFlowedText` (RFC 3676 format=flowed), in linear time. The original folds the lines
 * with `reduce`, appending to one growing string and calling `endsWith` on it for every line, so a 2.4 MB message of
 * 39,000 flowed lines took about 25 seconds to parse. This returns exactly what the original returns, for any input:
 * a line ending in a space joins the next (dropping that space with DelSp=yes), unless the text since the last line
 * break is the signature separator `-- `; then one leading space is removed from every line (space stuffing).
 */
export function decodeFlowedText(text: string, delSp: boolean): string {
	const lines = text.split(/\r?\n/);
	// The result as pieces, never an empty one, so the last piece holds the last character.
	const pieces: string[] = [];
	// The text since the last line break: its length and its first four characters, enough to tell `-- ` apart.
	let tailLength = 0;
	let tailStart = "";
	const append = (line: string) => {
		if (!line) return;
		pieces.push(line);
		if (tailLength < 4) tailStart = (tailStart + line).slice(0, 4);
		tailLength += line.length;
	};
	append(lines[0]);
	for (let index = 1; index < lines.length; index++) {
		const last = pieces[pieces.length - 1];
		const flowed = last?.endsWith(" ") && !(tailLength === 3 && tailStart === "-- ");
		if (!flowed) {
			pieces.push("\n");
			tailLength = 0;
			tailStart = "";
		} else if (delSp) {
			// The space that made the line flowed belongs to the text since the last line break.
			if (last.length === 1) pieces.pop();
			else pieces[pieces.length - 1] = last.slice(0, -1);
			tailLength--;
			tailStart = tailStart.slice(0, Math.min(4, tailLength));
		}
		append(lines[index]);
	}
	return pieces.join("").replace(/^ /gm, "");
}
