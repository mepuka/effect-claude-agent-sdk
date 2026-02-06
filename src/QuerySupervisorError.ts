import * as Schema from "effect/Schema"

/**
 * Raised when the pending queue rejects a new submission.
 */
export class QueryQueueFullError extends Schema.TaggedError<QueryQueueFullError>()(
  "QueryQueueFullError",
  {
    message: Schema.String,
    queryId: Schema.String,
    capacity: Schema.Number,
    strategy: Schema.String
  }
) {}

/**
 * Raised when a pending query waits too long before starting.
 */
export class QueryPendingTimeoutError extends Schema.TaggedError<QueryPendingTimeoutError>()(
  "QueryPendingTimeoutError",
  {
    message: Schema.String,
    queryId: Schema.String,
    timeoutMs: Schema.Number
  }
) {}

/**
 * Raised when the submitting scope closes before a query starts.
 */
export class QueryPendingCanceledError extends Schema.TaggedError<QueryPendingCanceledError>()(
  "QueryPendingCanceledError",
  {
    message: Schema.String,
    queryId: Schema.String
  }
) {}

/**
 * Union of all query supervisor errors.
 */
export const QuerySupervisorError = Schema.Union(
  QueryQueueFullError,
  QueryPendingTimeoutError,
  QueryPendingCanceledError
)

export type QuerySupervisorError = typeof QuerySupervisorError.Type
export type QuerySupervisorErrorEncoded = typeof QuerySupervisorError.Encoded
