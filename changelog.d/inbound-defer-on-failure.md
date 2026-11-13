### Fixed

- Mail that arrives while Kite briefly cannot store it, or while a self-hosted server is unreachable from the email relay, is now deferred so the sender's server tries again later, instead of being bounced. A retried message is stored once, and a kept copy is forwarded once (ported from upstream Mailflare #281).
