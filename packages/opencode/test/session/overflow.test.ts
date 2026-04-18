import { describe, expect, it } from "bun:test"
import { isOverflow } from "../../src/session/overflow"

const model = {
  id: "test",
  limit: { context: 200_000, input: 200_000, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
} as any

const tokens = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: input,
})

describe("isOverflow — compaction.threshold (A3)", () => {
  it("without threshold, triggers only at >= usable (old behavior)", () => {
    const cfg = { compaction: { reserved: 20_000 } } as any
    expect(isOverflow({ cfg, model, tokens: tokens(179_999) })).toBe(false)
    expect(isOverflow({ cfg, model, tokens: tokens(180_000) })).toBe(true)
  })

  it("threshold 0.85 triggers at 85% of usable", () => {
    const cfg = { compaction: { reserved: 20_000, threshold: 0.85 } } as any
    expect(isOverflow({ cfg, model, tokens: tokens(152_999) })).toBe(false)
    expect(isOverflow({ cfg, model, tokens: tokens(153_000) })).toBe(true)
  })

  it("threshold clamped to (0, 1]", () => {
    const cfgZero = { compaction: { reserved: 20_000, threshold: 0 } } as any
    expect(isOverflow({ cfg: cfgZero, model, tokens: tokens(179_999) })).toBe(false)

    const cfgOne = { compaction: { reserved: 20_000, threshold: 1 } } as any
    expect(isOverflow({ cfg: cfgOne, model, tokens: tokens(179_999) })).toBe(false)
    expect(isOverflow({ cfg: cfgOne, model, tokens: tokens(180_000) })).toBe(true)
  })

  it("auto: false disables overflow regardless of threshold", () => {
    const cfg = { compaction: { auto: false, threshold: 0.5 } } as any
    expect(isOverflow({ cfg, model, tokens: tokens(195_000) })).toBe(false)
  })
})
