import type { NamedError } from "@opencode-ai/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export type Err = ReturnType<NamedError["toObject"]>

  // This exported message is shared with the TUI upsell detector. Matching on a
  // literal error string kind of sucks, but it is the simplest for now.
  export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go https://opencode.ai/go"

  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  function cap(ms: number) {
    return Math.min(ms, RETRY_MAX_DELAY)
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    // #13 Overloaded (529) needs extra breathing room — hammering a
    // struggling provider just makes things worse. Double the base and
    // use a higher backoff factor for this code path specifically.
    const isOverloaded = error?.data.statusCode === 529
    const initial = isOverloaded ? RETRY_INITIAL_DELAY * 2 : RETRY_INITIAL_DELAY
    const factor = isOverloaded ? 3 : RETRY_BACKOFF_FACTOR

    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return cap(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return cap(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return cap(Math.ceil(parsed))
          }
        }

        return cap(initial * Math.pow(factor, attempt - 1))
      }
    }

    return cap(Math.min(initial * Math.pow(factor, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
  }

  export function retryable(error: Err) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      // #13 Auth failures (401/403) must never be retried — retrying thrashes
      // the account and masks the real problem. Billing errors (402) likewise.
      const status = error.data.statusCode
      if (status === 401 || status === 403) return undefined
      if (status === 402) return undefined
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError")) return GO_UPSELL_MESSAGE
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    // Check for rate limit patterns in plain text error messages
    const msg = error.data?.message
    if (typeof msg === "string") {
      const lower = msg.toLowerCase()
      if (
        lower.includes("rate increased too quickly") ||
        lower.includes("rate limit") ||
        lower.includes("too many requests")
      ) {
        return msg
      }
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    if (!json || typeof json !== "object") return undefined
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return "Too Many Requests"
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded"
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return "Rate Limited"
    }
    return undefined
  }

  export function policy(opts: {
    parse: (error: unknown) => Err
    set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  }) {
    return Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
        const error = opts.parse(meta.input)
        const message = retryable(error)
        if (!message) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
          const now = yield* Clock.currentTimeMillis
          yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
      }),
    )
  }
}
