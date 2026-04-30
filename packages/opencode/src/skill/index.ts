import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, Context, Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Log from "@opencode-ai/core/util/log"
import { Discovery } from "./discovery"

const log = Log.create({ service: "skill" })
const EXTERNAL_DIRS = [".claude", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
// #14 Tier 1: Claude Code plugin cache layout. Plugins installed via
// `claude plugin install` land at ~/.claude/plugins/cache/<publisher>/<plugin>/<ver>/skills/<skill>/SKILL.md.
// The standard EXTERNAL_SKILL_PATTERN (skills/**/SKILL.md) won't match those
// because the plugin tree doesn't start with a "skills/" directory — it's
// nested under "plugins/cache/**/". This pattern captures them.
const PLUGIN_CACHE_SKILL_PATTERN = "plugins/cache/**/skills/**/SKILL.md"
// #14 Tier 2: Loose-format skills. Users often drop single .md files in
// ~/.claude/skills/ rather than creating a subdir per skill. These lack
// proper frontmatter — we infer name from filename and description from
// the first heading or first non-empty paragraph. See addFlat() below.
const EXTERNAL_FLAT_PATTERN = "skills/*.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  location: Schema.String,
  content: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  // #14 Tier 2: paths of loose .md skill files that must be parsed via addFlat.
  flatMatches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  flatMatches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

// #14 Tier 2: Description fallback — prefer first H1, else first non-empty
// paragraph, truncated to keep system-prompt footprint bounded.
function inferDescription(body: string): string {
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/)
    if (h1) return h1[1].slice(0, 200)
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#")) continue
    return trimmed.slice(0, 200)
  }
  return ""
}

// #14 Tier 2: Parse a flat .md skill file where frontmatter may be missing
// or incomplete. Fallback strategy:
//   - name: basename(file, ".md") if frontmatter.name absent
//   - description: first H1 heading text, else first non-empty paragraph,
//     truncated to 200 chars. Empty description is allowed (renders as "").
// Content is always the full file body (frontmatter-stripped when present).
const addFlat = Effect.fnUntraced(function* (state: State, match: string, bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse flat skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load flat skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  const data = md.data as Record<string, unknown>
  const fmName = typeof data.name === "string" ? data.name : undefined
  const fmDesc = typeof data.description === "string" ? data.description : undefined
  const name = fmName ?? path.basename(match, ".md")
  const description = fmDesc ?? inferDescription(md.content)

  if (state.skills[name]) {
    log.warn("duplicate skill name", {
      name,
      existing: state.skills[name].location,
      duplicate: match,
    })
    return
  }

  state.dirs.add(path.dirname(match))
  state.skills[name] = {
    name,
    description,
    location: match,
    content: md.content,
  }
})

const add = Effect.fnUntraced(function* (state: State, match: string, bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)
  if (!parsed.success) return

  if (state.skills[parsed.data.name]) {
    log.warn("duplicate skill name", {
      name: parsed.data.name,
      existing: state.skills[parsed.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[parsed.data.name] = {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string; flat?: boolean },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    // #14 Tier 2: route flat .md skills to a separate bucket so that
    // loadSkills() can pick the right parser (addFlat vs add).
    if (opts?.flat) state.flatMatches.add(match)
    else state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), flatMatches: new Set(), dirs: new Set() }

  if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
    for (const dir of EXTERNAL_DIRS) {
      const root = path.join(Global.Path.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
      // #14 Tier 2: also grab loose .md files directly in skills/.
      yield* scan(state, root, EXTERNAL_FLAT_PATTERN, { dot: true, scope: "global-flat", flat: true })
    }

    // #14 Tier 1: walk the Claude Code plugin cache at ~/.claude/plugins/cache.
    // Plugins are discovered via the standard SKILL.md nested layout but
    // rooted under plugins/cache/<publisher>/<plugin>/<ver>/skills/.
    const pluginHome = path.join(Global.Path.home, ".claude")
    if (yield* fsys.isDir(pluginHome)) {
      yield* scan(state, pluginHome, PLUGIN_CACHE_SKILL_PATTERN, { dot: true, scope: "plugin-cache" })
    }

    const upDirs = yield* fsys
      .up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
      // #14 Tier 2: project-level loose .md skills.
      yield* scan(state, root, EXTERNAL_FLAT_PATTERN, { dot: true, scope: "project-flat", flat: true })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    flatMatches: Array.from(state.flatMatches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState, bus: Bus.Interface) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, bus), {
    concurrency: "unbounded",
    discard: true,
  })
  yield* Effect.forEach(discovered.flatMatches, (match) => addFlat(state, match, bus), {
    concurrency: "unbounded",
    discard: true,
  })

  log.info("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(config, discovery, fsys, ctx.directory, ctx.worktree)
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (ctx) {
        const s: State = { skills: {}, dirs: new Set() }
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, all, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
