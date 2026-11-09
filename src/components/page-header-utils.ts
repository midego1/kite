// A page's primary "New ..." button floats at the bottom of the screen on phones, within thumb reach and
// clear of the tab bar (3.75rem plus the safe-area inset, and the bar's 0.75rem gap).
export const mobilePrimaryActionClass =
	"max-md:fixed max-md:inset-x-4 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-md:z-40 max-md:h-12 max-md:rounded-full max-md:shadow-lg";

// Same, lifted above the settings section pill (whose top is 7rem up, plus the bar's safe-area inset).
export const mobilePrimaryActionAboveNavClass =
	"max-md:fixed max-md:inset-x-4 max-md:bottom-[calc(8rem+env(safe-area-inset-bottom))] max-md:z-40 max-md:h-12 max-md:rounded-full max-md:shadow-lg";

// A scrollable list or form's own bottom padding, so its last row is never trapped under a floating primary
// action button or section pill (both float at the same `bottom-[calc(4.5rem+...)]`, about 8rem of clearance).
export const mobileScrollClearsFloatingActionClass = "max-md:pb-[calc(8rem+env(safe-area-inset-bottom))]";
