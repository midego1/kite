### Fixed

- Mail that arrives while Kite cannot store it, or while a self-hosted server is unreachable from the email relay, is now deferred so the sender's server tries again later, instead of being bounced back to the sender (ported from upstream Mailflare #281).
