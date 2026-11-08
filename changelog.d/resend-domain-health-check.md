### Fixed

- The Domains page no longer shows a correctly configured Resend sending domain as missing its SPF record: the health check now looks at the subdomain Resend actually publishes it on, not only the root domain. The Resend receiving MX check is also more forgiving of Resend's own published records.
