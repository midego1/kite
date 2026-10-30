-- Admin → General → Sender authentication: "Treat every DMARC failure as spam". Off by default, when only a failure
-- from a domain that publishes p=quarantine or p=reject (or SPF and DKIM failing together) files mail as spam.
ALTER TABLE `app_settings` ADD `spam_strict_dmarc` integer DEFAULT 0 NOT NULL;
