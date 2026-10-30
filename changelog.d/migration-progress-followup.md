### Fixed

- Applying database updates holds up better on slow or unreliable connections: a timed-out update is followed for up to 20 minutes before it is reported as unknown, a request that never answers is cut off once every update has landed, and other tabs show the busy state reliably, even while hidden.
