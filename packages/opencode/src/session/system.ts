import { Context, Effect, Layer, Stream } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Bus } from "@/bus"
import type { SessionID } from "./schema"
import { Event as SessionEvent } from "./session"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  /**
   * Compute a fresh environment preamble. Uses `new Date()` at call time and
   * does NOT consult any cache, so every call returns a newly-built array.
   * Preserved for backward compatibility and for code paths (tests, subagent
   * edges) that genuinely want a just-computed snapshot.
   */
  readonly environment: (model: Provider.Model) => string[]
  /**
   * Session-stable env preamble. The first call for a given `sessionID`
   * computes the env block and caches the result; subsequent calls return
   * the same array reference until `invalidateSessionEnv(sessionID)` is
   * invoked. This keeps "Today's date" (and future env fields like git
   * branch / open files) stable for the lifetime of a session, preventing
   * cache-breaking rewrites of the system prompt at midnight rollover.
   */
  readonly environmentForSession: (sessionID: SessionID, model: Provider.Model) => string[]
  /**
   * Drop the cached env snapshot for a session so the next call to
   * `environmentForSession` recomputes with current values. Exposed for
   * future `/refresh`-style callers; no-op when the session has no cached
   * entry.
   */
  readonly invalidateSessionEnv: (sessionID: SessionID) => void
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const bus = yield* Bus.Service

    // Session-keyed env snapshot cache. Keeps the env preamble stable for
    // the lifetime of a session so date/branch/etc don't invalidate the
    // provider-side prompt cache mid-session.
    const envCache = new Map<SessionID, string[]>()

    // Purge the cached env snapshot when a session is deleted so the map
    // does not grow unbounded across long-lived instances.
    yield* bus.subscribe(SessionEvent.Deleted).pipe(
      Stream.runForEach((evt) => Effect.sync(() => envCache.delete(evt.properties.sessionID))),
      Effect.forkScoped,
    )

    function buildEnv(model: Provider.Model): string[] {
      const project = Instance.project
      return [
        [
          `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
          `Here is some useful information about the environment you are running in:`,
          `<env>`,
          `  Working directory: ${Instance.directory}`,
          `  Workspace root folder: ${Instance.worktree}`,
          `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
          `  Platform: ${process.platform}`,
          `  Today's date: ${new Date().toDateString()}`,
          `</env>`,
        ].join("\n"),
      ]
    }

    return Service.of({
      environment(model) {
        return buildEnv(model)
      },

      environmentForSession(sessionID, model) {
        const cached = envCache.get(sessionID)
        if (cached) return cached
        const fresh = buildEnv(model)
        envCache.set(sessionID, fresh)
        return fresh
      },

      invalidateSessionEnv(sessionID) {
        envCache.delete(sessionID)
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provideMerge(Skill.defaultLayer), Layer.provideMerge(Bus.defaultLayer))

export * as SystemPrompt from "./system"
