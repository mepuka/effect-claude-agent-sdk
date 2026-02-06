import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

export type NdjsonDecodeStage = "parse" | "decode"

export type NdjsonDecodeErrorDetails = {
  readonly stage: NdjsonDecodeStage
  readonly line: string
  readonly cause: unknown
}

export const decodeNdjson = <S extends Schema.Schema.AnyNoContext, E>(
  schema: S,
  onError: (details: NdjsonDecodeErrorDetails) => E
) => {
  const decode = Schema.decodeUnknown(schema)

  return <E0, R>(stream: Stream.Stream<string, E0, R>) =>
    stream.pipe(
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Effect.gen(function*() {
          const value = yield* Effect.try({
            try: () => JSON.parse(line) as unknown,
            catch: (cause) => onError({ stage: "parse", line, cause })
          })
          return yield* decode(value).pipe(
            Effect.mapError((cause) =>
              onError({ stage: "decode", line, cause })
            )
          )
        })
      )
    )
}
