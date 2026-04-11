import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Locale } from "@/util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { formatTokens, CACHE_HIT_GOOD, CACHE_HIT_WARN } from "../../util/format-tokens"
import { useCacheStats } from "../../util/cache-stats"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const assistants = createMemo(() => messages().filter((m): m is AssistantMessage => m.role === "assistant"))
  const lastAssistant = createMemo(() => assistants().at(-1))
  const cache = useCacheStats(messages)

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const status = createMemo(() => sync.data.session_status?.[route.sessionID] ?? { type: "idle" })

  const [turnElapsed, setTurnElapsed] = createSignal("")
  const [tps, setTps] = createSignal<{ value: number; live: boolean } | null>(null)
  const turnState = { ts: 0, lastTokenCount: 0, lastTokenTs: 0, tpsSamples: [] as number[] }
  createEffect(() => {
    const s = status()
    if (s.type !== "idle") {
      if (!turnState.ts) {
        turnState.ts = Date.now()
        turnState.lastTokenTs = Date.now()
        turnState.lastTokenCount = 0
        turnState.tpsSamples = []
      }
      const interval = setInterval(() => {
        const now = Date.now()
        const sec = Math.floor((now - turnState.ts) / 1000)
        const m = Math.floor(sec / 60)
        const ss = sec % 60
        setTurnElapsed(m > 0 ? `${m}m${String(ss).padStart(2, "0")}s` : `${ss}s`)
        const last = lastAssistant()
        if (!last) return
        const outNow = last.tokens.output + last.tokens.reasoning
        const delta = outNow - turnState.lastTokenCount
        const deltaMs = now - turnState.lastTokenTs
        if (delta > 0 && deltaMs > 0) {
          const instant = (delta / deltaMs) * 1000
          turnState.tpsSamples.push(instant)
          setTps({ value: Math.round(instant), live: true })
        }
        turnState.lastTokenCount = outNow
        turnState.lastTokenTs = now
      }, 1000)
      onCleanup(() => clearInterval(interval))
    } else {
      if (turnState.tpsSamples.length > 0) {
        const avg = turnState.tpsSamples.reduce((a, b) => a + b, 0) / turnState.tpsSamples.length
        setTps({ value: Math.round(avg), live: false })
      }
      turnState.ts = 0
      turnState.lastTokenCount = 0
      turnState.lastTokenTs = 0
      turnState.tpsSamples = []
    }
  })

  const usage = createMemo(() => {
    const all = assistants().filter((m) => m.tokens.output > 0)
    const last = all.at(-1)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const ctxLimit = model?.limit.context
    const pctNum = ctxLimit ? Math.min(100, Math.round((tokens / ctxLimit) * 100)) : undefined
    const cost = messages().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    const cacheRead = last.tokens.cache.read
    const turnIn = last.tokens.input + cacheRead + last.tokens.cache.write
    const turnOut = last.tokens.output + last.tokens.reasoning

    const sessionHitRate = (() => {
      const total = all.reduce((s, m) => s + m.tokens.input + m.tokens.cache.read + m.tokens.cache.write, 0)
      const reads = all.reduce((s, m) => s + m.tokens.cache.read, 0)
      return total > 0 ? Math.round((reads / total) * 100) : undefined
    })()

    const ctxStr = ctxLimit
      ? `🧠${formatTokens(tokens)}/${formatTokens(ctxLimit)} (${pctNum}%)`
      : `🧠${formatTokens(tokens)}`

    return {
      context: ctxStr,
      cost: cost > 0 ? money.format(cost) : undefined,
      turn: `↑${formatTokens(turnIn)}${cacheRead > 0 ? ` (${formatTokens(cacheRead)} hit)` : ""} ↓${formatTokens(turnOut)}`,
      hitRate: sessionHitRate !== undefined ? `💾${sessionHitRate}%` : undefined,
    }
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {[
                    turnElapsed() || undefined,
                    tps() ? `${tps()!.live ? "⚡" : "≈"}${tps()!.value}t/s` : undefined,
                    item().turn,
                    item().hitRate,
                    item().context,
                    item().cost,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
