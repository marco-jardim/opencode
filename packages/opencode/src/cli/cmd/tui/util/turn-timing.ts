import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const MAX_TPS_SAMPLES = 120

export interface TurnTiming {
  elapsed: Accessor<string>
  tps: Accessor<{ value: number; live: boolean } | null>
}

export function useTurnTiming(
  status: Accessor<{ type: string }>,
  lastAssistant: Accessor<AssistantMessage | undefined>,
): TurnTiming {
  const [elapsed, setElapsed] = createSignal("")
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
        setElapsed(m > 0 ? `${m}m${String(ss).padStart(2, "0")}s` : `${ss}s`)
        const last = lastAssistant()
        if (!last) return
        const outNow = last.tokens.output + last.tokens.reasoning
        const delta = outNow - turnState.lastTokenCount
        const deltaMs = now - turnState.lastTokenTs
        if (delta > 0 && deltaMs > 0) {
          const instant = (delta / deltaMs) * 1000
          if (turnState.tpsSamples.length >= MAX_TPS_SAMPLES) turnState.tpsSamples.shift()
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

  return { elapsed, tps }
}
