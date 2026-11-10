-- A category on a payment found in mail (docs/specs/money-watch.md §27): one of a small fixed set
-- (software, shopping, food, travel, utilities, health, entertainment, education, other), set by code where one is
-- obvious and changed by hand in the Payments tab. Null is no category. The set is enforced in code, not here, so a
-- later category needs no migration. Reads and inserts keep working before this is applied (`selectRows` and
-- `insertRow` treat the column as pending); changing a category before then answers 409 MIGRATION_PENDING.
ALTER TABLE `finance_payments` ADD `category` text;
