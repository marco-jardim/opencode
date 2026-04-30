import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Log from "@opencode-ai/core/util/log"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

const log = Log.create({ service: "command" })

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: BusEvent.define(
    "command.executed",
    Schema.Struct({
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    }),
  ),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill", "claude"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown.annotate({ [ZodOverride]: z.promise(z.string()).or(z.string()) }),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
})
  .annotate({ identifier: "Command" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

// #33 Tier 3: Load Claude Code-style markdown commands from:
//   - ~/.claude/commands/**/*.md               (global user commands)
//   - <worktree-ancestors>/.claude/commands/**/*.md  (project commands)
//   - ~/.claude/plugins/cache/**/commands/**/*.md     (plugin commands)
//
// Name derivation follows Claude Code convention: relative path from the
// commands/ root, "/" → ":", ".md" stripped. So sub/foo.md → "sub:foo".
// First occurrence wins (user → project → plugin) to keep personal
// commands authoritative over plugins.
async function loadClaudeCommands(worktree: string, directory: string): Promise<Record<string, Info>> {
  const result: Record<string, Info> = {}

  // #33 Derive a colon-namespaced command name from a file path relative
  // to its commands/ root. Normalizes path separators and strips ".md".
  const nameFrom = (rel: string) => rel.replace(/\\/g, "/").replace(/\.md$/i, "").replace(/\//g, ":")

  const parseCommand = async (file: string, name: string, scope: string) => {
    if (result[name]) return
    try {
      const md = await ConfigMarkdown.parse(file)
      const data = md.data as Record<string, unknown>
      const description = typeof data.description === "string" ? data.description : undefined
      const agent = typeof data.agent === "string" ? data.agent : undefined
      const model = typeof data.model === "string" ? data.model : undefined
      const content = md.content
      result[name] = {
        name,
        description,
        agent,
        model,
        source: "claude",
        get template() {
          return content
        },
        hints: hints(content),
      }
    } catch (err) {
      log.error("failed to load claude command", { file, scope, err })
    }
  }

  const scanRoot = async (root: string, scope: string) => {
    if (!(await Filesystem.isDir(root))) return
    try {
      const matches = await Glob.scan("**/*.md", {
        cwd: root,
        absolute: true,
        include: "file",
        dot: false,
      })
      for (const match of matches) {
        const rel = path.relative(root, match)
        const name = nameFrom(rel)
        if (!name) continue
        await parseCommand(match, name, scope)
      }
    } catch (err) {
      log.error(`failed to scan ${scope} claude commands`, { root, err })
    }
  }

  // 1) Global user commands: ~/.claude/commands
  const userRoot = path.join(Global.Path.home, ".claude", "commands")
  await scanRoot(userRoot, "user")

  // 2) Project commands via walk-up: <cwd>/<..>/.claude/commands
  try {
    for await (const claudeDir of Filesystem.up({
      targets: [".claude"],
      start: directory,
      stop: worktree,
    })) {
      const commandsDir = path.join(claudeDir, "commands")
      await scanRoot(commandsDir, "project")
    }
  } catch (err) {
    log.error("failed to walk up for claude commands", { directory, worktree, err })
  }

  // 3) Plugin cache commands: ~/.claude/plugins/cache/**/commands/**/*.md
  const pluginHome = path.join(Global.Path.home, ".claude")
  if (await Filesystem.isDir(pluginHome)) {
    try {
      const pluginMatches = await Glob.scan("plugins/cache/**/commands/**/*.md", {
        cwd: pluginHome,
        absolute: true,
        include: "file",
        dot: false,
      })
      for (const match of pluginMatches) {
        const normalized = match.replace(/\\/g, "/")
        const idx = normalized.lastIndexOf("/commands/")
        if (idx === -1) continue
        const rel = normalized.slice(idx + "/commands/".length)
        const name = nameFrom(rel)
        if (!name) continue
        await parseCommand(match, name, "plugin")
      }
    } catch (err) {
      log.error("failed to scan plugin claude commands", { pluginHome, err })
    }
  }

  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      // #33 Tier 3: Merge Claude Code markdown commands. Priority order:
      // Default > Config > MCP > Claude > Skill. Skip-if-exists guards
      // below ensure higher-priority commands shadow Claude commands.
      if (!Flag.OPENCODE_DISABLE_EXTERNAL_COMMANDS) {
        const claudeCommands = yield* Effect.promise(() => loadClaudeCommands(ctx.worktree, ctx.directory))
        for (const [name, cmd] of Object.entries(claudeCommands)) {
          if (commands[name]) continue
          commands[name] = cmd
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
