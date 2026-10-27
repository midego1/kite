### Fixed

- Money Watch no longer misses the end of a compressed PDF page when its data happens to end in a line-break byte: it now uses the length the PDF states for each stream, so the last lines of an invoice (often the total) are read.
