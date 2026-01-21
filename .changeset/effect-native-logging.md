---
"effect-claude-agent-sdk": minor
---

Add Effect-native logging helpers

- New `Logging` module with pattern matching for SDK message events
- `LoggingConfig` for configurable log levels and formatting
- `LoggingLayer` for integrating SDK logging with Effect's logger
- `LoggingMatch` combinators for building custom message handlers
- `LoggingStream` utilities for streaming log transformations
