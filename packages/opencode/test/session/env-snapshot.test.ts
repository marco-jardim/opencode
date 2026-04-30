import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { Event as SessionEvent } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

function fakeModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 100_000, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { id: "claude-test", url: "https://example.test", npm: "@ai-sdk/anthropic" },
    options: {},
    headers: {},
    status: "active",
    release_date: "2024-01-01",
  } as Provider.Model
}

const OriginalDate = Date

function withMockedDate<A>(iso: string, fn: () => A): A {
  const fixed = new OriginalDate(iso).getTime()
  // Build a Date-compatible mock via Proxy so `new Date()` returns a Date
  // pinned to `fixed`, while `new Date(x)` and other calls delegate to the
  // real constructor. This preserves full Date semantics without any type
  // suppression.
  const mock = new Proxy(OriginalDate, {
    construct(target, args) {
      if (args.length === 0) return new target(fixed)
      return Reflect.construct(target, args)
    },
    get(target, prop, receiver) {
      if (prop === "now") return () => fixed
      return Reflect.get(target, prop, receiver)
    },
  })
  const globals = globalThis as unknown as { Date: DateConstructor }
  globals.Date = mock
  try {
    return fn()
  } finally {
    globals.Date = OriginalDate
  }
}

afterEach(() => {
  ;(globalThis as unknown as { Date: DateConstructor }).Date = OriginalDate
})

describe("session.system env snapshot", () => {
  test("memoizes env array per sessionID; fresh array for different sessionID", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = fakeModel()
        const sessionA = SessionID.descending()
        const sessionB = SessionID.descending()

        const run = Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const first = svc.environmentForSession(sessionA, model)
          const second = svc.environmentForSession(sessionA, model)
          const other = svc.environmentForSession(sessionB, model)
          return { first, second, other }
        }).pipe(Effect.provide(SystemPrompt.defaultLayer))

        const { first, second, other } = await Effect.runPromise(run)

        // Same array reference within a session
        expect(first).toBe(second)
        // Fresh (different) array reference for different session
        expect(other).not.toBe(first)
        // Content is structurally identical though
        expect(other).toEqual(first)
      },
    })
  })

  test("date stays stable across calls even if real date advances", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = fakeModel()
        const sessionID = SessionID.descending()

        // Single Effect that captures the env BOTH times through the SAME
        // Service instance (same cache). Date is swapped between calls.
        const program = Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const firstEnv = withMockedDate("2026-04-18T10:00:00.000Z", () =>
            svc.environmentForSession(sessionID, model),
          )
          const secondEnv = withMockedDate("2026-04-19T10:00:00.000Z", () =>
            svc.environmentForSession(sessionID, model),
          )
          return { firstEnv, secondEnv }
        }).pipe(Effect.provide(SystemPrompt.defaultLayer))

        const { firstEnv, secondEnv } = await Effect.runPromise(program)

        const originalDateStr = new OriginalDate("2026-04-18T10:00:00.000Z").toDateString()
        const newDateStr = new OriginalDate("2026-04-19T10:00:00.000Z").toDateString()

        expect(firstEnv.some((s) => s.includes(`Today's date: ${originalDateStr}`))).toBe(true)
        // Memoization must win over the advanced wall-clock
        expect(secondEnv.some((s) => s.includes(`Today's date: ${originalDateStr}`))).toBe(true)
        expect(secondEnv.some((s) => s.includes(`Today's date: ${newDateStr}`))).toBe(false)
        // Same reference means zero chance of drift
        expect(secondEnv).toBe(firstEnv)
      },
    })
  })

  test("invalidateSessionEnv forces a fresh snapshot with current date", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = fakeModel()
        const sessionID = SessionID.descending()

        const program = Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const firstEnv = withMockedDate("2026-04-18T10:00:00.000Z", () =>
            svc.environmentForSession(sessionID, model),
          )
          // Invalidate, then call with "next day" — must reflect the NEW date
          const secondEnv = withMockedDate("2026-04-19T10:00:00.000Z", () => {
            svc.invalidateSessionEnv(sessionID)
            return svc.environmentForSession(sessionID, model)
          })
          return { firstEnv, secondEnv }
        }).pipe(Effect.provide(SystemPrompt.defaultLayer))

        const { firstEnv, secondEnv } = await Effect.runPromise(program)

        const oldDateStr = new OriginalDate("2026-04-18T10:00:00.000Z").toDateString()
        const newDateStr = new OriginalDate("2026-04-19T10:00:00.000Z").toDateString()

        expect(firstEnv.some((s) => s.includes(`Today's date: ${oldDateStr}`))).toBe(true)
        // After invalidation, the new snapshot must have the new date
        expect(secondEnv.some((s) => s.includes(`Today's date: ${newDateStr}`))).toBe(true)
        // And must not retain the old date
        expect(secondEnv.some((s) => s.includes(`Today's date: ${oldDateStr}`))).toBe(false)
        // And must be a fresh array reference
        expect(secondEnv).not.toBe(firstEnv)
      },
    })
  })

  test("Session.Event.Deleted purges the cached env snapshot", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = fakeModel()
        const sessionID = SessionID.descending()

        const program = Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const bus = yield* Bus.Service

          // Let the layer's bus subscription finish wiring up before we
          // publish — forkScoped returns before the first runForEach pull.
          yield* Effect.sleep("20 millis")

          const before = svc.environmentForSession(sessionID, model)
          const cachedHit = svc.environmentForSession(sessionID, model)

          // Publish the deletion event and yield long enough for the
          // bus subscriber forked inside the layer to process it.
          yield* bus.publish(SessionEvent.Deleted, {
            sessionID,
            info: {
              id: sessionID,
              title: "",
              version: "",
              time: { created: 0, updated: 0 },
              revert: undefined,
            },
          } as never)
          yield* Effect.sleep("20 millis")

          const after = svc.environmentForSession(sessionID, model)
          return { before, cachedHit, after }
        }).pipe(Effect.provide(SystemPrompt.defaultLayer))

        const { before, cachedHit, after } = await Effect.runPromise(program)

        // Sanity check — cache was populated pre-delete
        expect(cachedHit).toBe(before)
        // Post-delete call must produce a new array reference (fresh build)
        expect(after).not.toBe(before)
      },
    })
  })
})
