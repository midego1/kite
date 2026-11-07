/** Marks an element whose own text holds a word long enough to need breaking anywhere; see `CELL_WRAP_STYLES`. */
const LONG_WORD_ATTRIBUTE = "data-kite-wrap";
// Longer than amounts, dates, order numbers and ordinary words, and as long as a URL usually is.
const LONG_WORD = /\S{30,}/;
const SHOW_TEXT = 4;

/**
 * Mail bodies wrap with `overflow-wrap: anywhere` so a long URL never widens the reader. In a table cell that also
 * shrinks the cell's minimum width to one character, so a column beside a `width: 100%` cell (a receipt's amount next
 * to its description) is squeezed into one character per line. Cells break words only where they would overflow
 * (`break-word`, which leaves the minimum width alone), and text marked by `markLongWords` still breaks anywhere.
 */
export const CELL_WRAP_STYLES = `td,th{overflow-wrap:break-word}[${LONG_WORD_ATTRIBUTE}]{overflow-wrap:anywhere}`;

/**
 * Marks the parent of every text node in a table cell under `root` that holds a long word, such as a URL written out in
 * a cell. Outside cells the body's own `anywhere` already applies.
 */
export function markLongWords(root: Element): void {
	const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement;
		if (parent?.closest("td,th") && LONG_WORD.test(node.nodeValue ?? "")) {
			parent.setAttribute(LONG_WORD_ATTRIBUTE, "anywhere");
		}
	}
}
