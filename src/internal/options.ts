import type { Options } from "../Schema/Options.js"

export const mergeOptions = (base: Options, override?: Partial<Options>): Options => ({
  ...base,
  ...(override ?? {})
})
