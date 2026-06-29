import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { createMemo, type Accessor } from "solid-js"

export interface CacheStats {
  read: number
  write: number
  input: number
  rate: number
  turns: number
}

export function useCacheStats(messages: Accessor<readonly Message[] | undefined>): Accessor<CacheStats> {
  return createMemo(() => {
    const msgs = messages() ?? []
    let read = 0
    let write = 0
    let input = 0
    let turns = 0
    for (const m of msgs) {
      if (m.role !== "assistant") continue
      const a = m as AssistantMessage
      if (!a.tokens?.cache) continue
      read += a.tokens.cache.read
      write += a.tokens.cache.write
      input += a.tokens.input
      turns++
    }
    const total = input + read + write
    const rate = total > 0 ? read / total : 0
    return { read, write, input, rate, turns }
  })
}
