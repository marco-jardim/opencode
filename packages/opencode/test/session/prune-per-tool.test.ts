import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { SessionCompaction } from "../../src/session/compaction"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) =>
        Effect.succeed({
          get message() {
            return input.assistantMessage
          },
          updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
          completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
          process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
        } satisfies SessionProcessorModule.SessionProcessor.Handle),
      ),
    }),
  )
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  processorLayer("continue"),
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCompaction.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

describe("session.compaction.prune per-tool-class thresholds", () => {
  it.live(
    "prunes reproducible tool outputs at 10k but protects stateful tool output under 40k",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Seed a user message so we have an initial turn.
        const seed = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: seed.id,
          sessionID: info.id,
          type: "text",
          text: "seed",
        })

        // Assistant turn carries the tool outputs (oldest -> newest):
        //   read #1, read #2, read #3 (~12k tokens each = 36k reproducible total),
        //   bash (~30k tokens stateful).
        // Token.estimate = chars / 4, so 12k tokens = 48k chars, 30k tokens = 120k chars.
        // Reproducible floor is 10k, so ~26k of reads get pruned (> PRUNE_MINIMUM 20k).
        // Stateful floor is 40k, so the 30k bash output stays intact.
        const a: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: seed.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(a)

        const readPartIDs: PartID[] = []
        for (let i = 0; i < 3; i++) {
          const id = PartID.ascending()
          readPartIDs.push(id)
          yield* ssn.updatePart({
            id,
            messageID: a.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "read",
            state: {
              status: "completed",
              input: {},
              output: "r".repeat(48_000), // ~12k tokens
              title: `read-${i}`,
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
        }

        const bashPartID = PartID.ascending()
        yield* ssn.updatePart({
          id: bashPartID,
          messageID: a.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "b".repeat(120_000), // ~30k tokens (< 40k stateful floor)
            title: "bash",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })

        // Two more user turns so prune's `turns < 2` guard does not skip the
        // assistant turn that holds the tool outputs.
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const toolParts = msgs
          .flatMap((msg) => msg.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")

        const reads = toolParts.filter((p) => p.tool === "read")
        const bash = toolParts.find((p) => p.tool === "bash")

        expect(reads).toHaveLength(3)
        expect(bash).toBeDefined()

        // Stateful: bash output (30k tokens) is within the 40k stateful floor.
        if (bash && bash.state.status === "completed") {
          expect(bash.state.time.compacted).toBeUndefined()
        }

        // Reproducible: only the newest ~10k tokens of read output survives,
        // so at least 2 of the 3 reads must be marked compacted.
        const compactedReads = reads.filter(
          (p) => p.state.status === "completed" && p.state.time.compacted !== undefined,
        )
        expect(compactedReads.length).toBeGreaterThanOrEqual(2)
      }),
    ),
  )
})
