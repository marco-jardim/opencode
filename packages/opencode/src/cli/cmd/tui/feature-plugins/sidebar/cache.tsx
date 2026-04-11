import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFile } from "node:fs/promises"
import { watchFile, unwatchFile } from "node:fs"
import { formatTokens, CACHE_HIT_GOOD, CACHE_HIT_WARN } from "../../util/format-tokens"
import { useCacheStats } from "../../util/cache-stats"

const id = "internal:sidebar-cache"

function getPluginConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

interface CacheStatsFile {
  turn?: {
    cache_read_tokens: number
    cache_write_tokens: number
    cache_hit_rate: number
    model: string
  }
  session?: {
    session_hit_rate: number
    avg_recent_hit_rate: number
    cost_usd: number
    cache_savings_usd: number
  }
  config?: {
    cache_ttl: string
    anti_verbosity: boolean
    length_anchors: boolean
  }
  timestamp?: string
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cache = useCacheStats(msg)

  const [pluginStats, setPluginStats] = createSignal<CacheStatsFile | null>(null)

  onMount(() => {
    const statsPath = join(getPluginConfigDir(), "cache-stats.json")

    async function poll() {
      try {
        const data = await readFile(statsPath, "utf-8")
        setPluginStats(JSON.parse(data))
      } catch {
        // File may not exist yet
      }
    }

    poll()
    watchFile(statsPath, { interval: 2000 }, () => poll())
    onCleanup(() => unwatchFile(statsPath))
  })

  const hitRateColor = createMemo(() => {
    if (cache().rate >= CACHE_HIT_GOOD) return theme().success
    if (cache().rate >= CACHE_HIT_WARN) return theme().warning
    return theme().error
  })

  const hitRatePercent = createMemo(() => Math.round(cache().rate * 100))

  return (
    <Show when={cache().turns > 0}>
      <box>
        <text fg={theme().text}>
          <b>Cache</b>
        </text>
        <text>
          <span style={{ fg: hitRateColor() }}>●</span>{" "}
          <span style={{ fg: theme().textMuted }}>{hitRatePercent()}% hit rate</span>
        </text>
        <text fg={theme().textMuted}>
          R: {formatTokens(cache().read)} W: {formatTokens(cache().write)}
        </text>
        <Show when={pluginStats()?.session?.cache_savings_usd}>
          {(savings) => <text fg={theme().success}>↓ ${savings().toFixed(4)} saved</text>}
        </Show>
        <Show when={pluginStats()?.config}>
          {(config) => (
            <text fg={theme().textMuted}>
              TTL: {config().cache_ttl}
              {config().anti_verbosity ? " · concise" : ""}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
