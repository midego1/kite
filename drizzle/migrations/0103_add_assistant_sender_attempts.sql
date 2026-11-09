-- Assistant by email, security review follow-up: caps verification-code guesses per code (never across codes —
-- mailing a new one resets it to 0), checked with an atomic compare-and-set in the same statement that updates
-- the row, so concurrent guesses against one code can never exceed the limit.
ALTER TABLE `assistant_sender_addresses` ADD `attempts` integer DEFAULT 0 NOT NULL;
