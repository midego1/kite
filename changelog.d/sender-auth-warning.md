### Added

- A message that failed SPF, DKIM or DMARC, carries a signature not issued for its own domain, replies to a different domain than it was sent from, or whose sender's name reuses one of your contacts at a different address, now shows a calm warning in the reader and a small badge next to its sender in the conversation. A message with nothing to flag, known contact or not, still shows neither.
  ![The reader's "This sender couldn't be fully verified" warning, listing a failed DMARC, SPF and DKIM check](/changelog/2026-11-08-sender-auth-warning-light.webp)
