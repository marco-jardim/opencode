export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream, mkdirSync } from "fs"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "OPENCODE_LOG_INITIALIZED_RUN_ID"

let level: Level = (() => {
  const env = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  return env && env in levelPriority ? (env as Level) : "INFO"
})()

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}

let fileWrite: ((msg: any) => number) | undefined
function ensureFileSink(): ((msg: any) => number) | undefined {
  if (fileWrite) return fileWrite
  try {
    mkdirSync(Global.Path.log, { recursive: true })
    logpath = path.join(Global.Path.log, new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log")
    const stream = createWriteStream(logpath, { flags: "a" })
    fileWrite = (msg: any) => {
      stream.write(msg)
      return msg.length
    }
    void cleanup(Global.Path.log)
  } catch {
    fileWrite = undefined
  }
  return fileWrite
}

let write = (msg: any) => {
  // Explicit opt-in (e.g. --print-logs) sends logs to stderr; otherwise route to
  // the rolling log file so logs never overwrite the TUI sharing this terminal.
  if (process.env.OPENCODE_PRINT_LOGS === "1") {
    process.stderr.write(msg)
    return msg.length
  }
  const sink = ensureFileSink()
  if (sink) return sink(msg)
  process.stderr.write(msg) // last-resort fallback if the log dir is unwritable
  return msg.length
}

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  if (options.print) {
    write = (msg: any) => {
      process.stderr.write(msg)
      return msg.length
    }
    return
  }
  // dev.log keeps its special-cased name and OPENCODE_RUN_ID-aware truncation; all
  // other cases reuse the single lazy file sink so there is exactly one file stream.
  if (options.dev) {
    try {
      mkdirSync(Global.Path.log, { recursive: true })
      logpath = path.join(Global.Path.log, "dev.log")
      const runID = process.env.OPENCODE_RUN_ID
      const shouldTruncate = !runID || process.env[initializedRunID] !== runID
      if (shouldTruncate) await fs.truncate(logpath).catch(() => {})
      if (runID) process.env[initializedRunID] = runID
      const stream = createWriteStream(logpath, { flags: "a" })
      fileWrite = (msg: any) => {
        stream.write(msg)
        return msg.length
      }
    } catch {
      fileWrite = undefined
    }
  } else {
    ensureFileSink()
  }
  write = (msg: any) => {
    const sink = fileWrite ?? ensureFileSink()
    if (sink) return sink(msg)
    process.stderr.write(msg)
    return msg.length
  }
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
