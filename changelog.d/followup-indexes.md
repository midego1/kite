### Changed

- Two background jobs, the receipt sweep and the clean-up of connected MCP apps, read less of the database with new indexes. This needs a database update, applied from the [Admin overview](/admin) as described in the [update instructions](https://github.com/midego1/kite/blob/main/docs/deployment.md#updating-kite); without it both keep working, only slower.

### Fixed

- Money Watch "Keep receipts": a filing that runs past its time limit is no longer filed a second time when you press "Save receipts for existing payments" while it is still finishing.
