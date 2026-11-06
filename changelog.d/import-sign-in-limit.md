### Security

- Importing mail from another server now stops after repeated failed sign-ins: ten in ten minutes, or five at the same server. Kite tells you how long to wait. Sign-ins that work, such as measuring a big folder in many steps, are never limited. See [Mail import](https://github.com/midego1/kite/blob/main/docs/modules.md#failed-sign-ins-and-oversized-messages).

### Fixed

- One very large message no longer makes an import fail. Kite skips it, names it in the import's problems and imports the rest. Big messages are also read in smaller groups, so imports use less memory.
