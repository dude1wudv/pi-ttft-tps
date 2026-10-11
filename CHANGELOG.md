# Changelog

## 0.1.0

Initial release.

- Footer segment `TTFT <time> | TPS <rate> | Cache <percent>`.
- TTFT anchored at `before_provider_request`, with `turn_start` as a fallback and idle provider calls ignored.
- TPS measured from the first token to `message_end`, with CJK-aware streaming token estimation and exact-usage correction.
- Cache hit rate computed as `cacheRead / (input + cacheRead + cacheWrite)`.
- Measured values persist across requests and are seeded from session history on resume.
- Works with the built-in footer; optional `pi-powerline-footer` custom item snippet included.
- Offline smoke tests (`npm test`).
