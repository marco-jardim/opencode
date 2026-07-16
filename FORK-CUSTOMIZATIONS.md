# Fork Customizations — Anti-Regression Register

> Fork: `marco-jardim/opencode` (remote `fork`) · Upstream: `anomalyco/opencode` (remote `origin`, branch `dev`)
> Last updated: 2026-07-16 (pre-merge snapshot; merge-base `1fd8bf526d`, 2026-06-29)
> Local state at snapshot: 65 commits ahead / 427 behind `origin/dev`.

This document is the authoritative contract of what the fork adds on top of upstream.
**Any upstream merge MUST preserve every item in section 1.** Use section 4 as the
post-merge verification checklist.

---

## 1. FORK-ONLY plugin API surfaces (hard contract — external plugins depend on these)

These do **not** exist upstream. Losing any of them breaks the plugins listed.

| # | API | Where (fork) | Consumed by |
|---|-----|--------------|-------------|
| 1 | Hook `experimental.session.summarize` | `packages/plugin/src/index.ts` (~:325); wired in `packages/opencode/src/session/compaction.ts` (~:356) | `opencode-anthropic-fix` |
| 2 | TUI slot `session_footer` | `packages/plugin/src/tui.ts` (~:499); rendered in `packages/tui/src/routes/session/index.tsx` (~:1297) | `opencode-rich-footer` (core feature) |
| 3 | TUI slot `session_above_prompt` | `packages/tui/src/routes/session/index.tsx` (~:1283) | fork TUI plugin infra |
| 4 | `onSlashSubmit` (TUI plugin slash commands with arguments) | `packages/plugin/src/tui.ts` (~:110); `packages/tui/src/plugin/command-shim.ts` (~:61) | fork TUI plugin infra (`/btw` style commands) |
| 5 | `api.state.session.children()` (sibling/child session enumeration) | `packages/plugin/src/tui.ts` (~:401); `packages/tui/src/plugin/adapters.tsx` (~:146) | `opencode-rich-footer` (treated as optional, but required for subagent stats) |

Related fork behaviors that back these APIs:

- `command.register` shim generates keymap bindings from `keybind` field and maps `enabled` (`packages/tui/src/plugin/command-shim.ts`).
- Slash dispatch uses `runCommand` (registered visibility) instead of `dispatchCommand` (active only); `handleSlash` uses unfiltered entries (`packages/tui/src/component/prompt/index.tsx`, `packages/tui/src/app.tsx`).
- TUI sync handles `session.created` to insert child sessions (needed by `session.children()`) (`packages/tui/src/context/sync.tsx` / `sync-v2.tsx`).
- `SubagentFooter` was **removed** in the fork (`packages/tui/src/routes/session/subagent-footer.tsx` deleted); its role moved to the `session_footer` slot provided by `opencode-rich-footer`. If upstream re-introduces/renames it, keep the deletion + slot.

## 2. External plugin contract matrix

APIs each plugin consumes. FORK-ONLY items in **bold**; everything else exists upstream (verified against `origin/dev` on 2026-07-16).

### `D:\git\opencode-anthropic-fix` (opencode-anthropic-fix@0.2.1)
- Hooks: `command.execute.before`, `experimental.chat.messages.transform`, `experimental.session.compacting`, **`experimental.session.summarize`**
- Client: `client.session.prompt`, `client.auth.set`, `client.tui.showToast`

### `D:\git\opencode-model-router` (opencode-model-router@1.3.0)
- Custom tool via `tool()` (`delegate`)
- Hooks: `chat.params`, `chat.message`, `tool.execute.before`, `tool.execute.after`, `experimental.text.complete`, `event` (`session.idle`), `config` (mutates `config.agent` / `config.command`), `experimental.chat.system.transform`, `command.execute.before`
- Client: `client.session.create`, `client.session.prompt`

### `D:\git\opencode-rich-footer` (opencode-rich-footer@0.1.0)
- Imports: `@opencode-ai/plugin/tui`, `@opencode-ai/sdk/v2`
- TUI API: `api.slots.register(`**`"session_footer"`**`)`, `api.state.session.get/messages/status/`**`children`**, `api.state.provider.find`, `api.theme.current`, `api.tuiConfig.keybinds.get`, `api.keys.formatBindings`, `api.keymap.dispatchCommand`

### `D:\git\opencode-telegram-plugin` (@tormentalabs/opencode-telegram-plugin@0.3.0)
- Hooks: `config`, `command.execute.before`, `event` for: `message.part.delta`, `message.part.updated`, `message.updated`, `session.created`, `session.idle`, `session.error`, `session.status`, `permission.asked`, `permission.updated`, `tool.execute.before`, `tool.execute.after`, `file.edited`
- SDK: `createOpencodeClient` from `@opencode-ai/sdk/v2/client`, `v2.app.log`
- Fragile: `ctx.client._client.getConfig()` (private access; check after merges)

## 3. Other fork customizations (behavioral, not plugin-facing)

Grouped from the 51 non-merge fork commits since merge-base `1fd8bf526d`:

### Session / core (`packages/opencode/src/session/*`, `packages/core`)
- `compaction.threshold` config: auto-compact before context overflow (`session/compaction.ts`, `session/overflow.ts`).
- Env snapshot cached per session; `envCache` purged on `session.deleted` (leak fix) (`session/system.ts` + `test/session/env-snapshot.test.ts`).
- Retry hardening for 529 overload + auth/billing errors, with an eight-attempt cap so retryable provider failures cannot retain sessions indefinitely (`session/retry.ts`).
- Provider loop guard exits after three consecutive `tool-calls` finishes without usable tool calls, preventing malformed provider output from retaining sessions indefinitely (`session/prompt.ts`).
- Subagent cost attribution and usage telemetry; telemetry demoted to debug level (`session/processor.ts`, `tool/task.ts`).
- Subagent system prompt scoping + token economy (`session/system.ts`, `tool/task.ts`).
- `util/log`: route to file by default, stderr only with `--print-logs` (`packages/core/src/util/log.ts`).
- NOTE: stale file-read eviction was moved OUT of core into `opencode-anthropic-fix` (commits `d01c8c724b`, `050ef3c001` reverts). Do not re-add in core.

### Commands / skills (`packages/opencode/src/command`, `src/skill`)
- Load Claude Code-style markdown commands from `.claude/commands` (`command/index.ts`, `core/src/config/markdown.ts`).
- Skill scan includes Claude Code plugin cache and flat `.md` skills; `flatMatches` in DiscoveryState (`skill/index.ts`).
- Tests: `test/command/claude-commands.test.ts`, `test/config/fixtures/hyphenated-keys.md`.

### TUI footer/stats (`packages/tui`)
- Enhanced footer bar: cache stats, token counters, tool count, compression indicator, turn timer (`routes/session/footer.tsx`).
- Moving-average TPS for final display (`util/turn-timing.ts`).
- Shared utils: `util/cache-stats.ts`, `util/format-tokens.ts`.
- Sidebar cache stats (`feature-plugins/sidebar/cache.tsx`).
- Session ID in sidebar on non-prod channels.

### Run / CLI
- `opencode run`: cost/token footer, context bar, `--stream-stdin` batch mode.

### Tooling
- `.husky/post-merge` hook auto-syncs dependencies (`bun install` after merges touching lockfile).
- `AGENTS.md` local additions.

## 4. Post-merge verification checklist

1. `git grep` these still exist and are wired:
   - `experimental.session.summarize` in `packages/plugin/src/index.ts` AND `packages/opencode/src/session/compaction.ts`
   - `session_footer` in `packages/plugin/src/tui.ts` AND `packages/tui/src/routes/session/index.tsx`
   - `session_above_prompt` in `packages/tui/src/routes/session/index.tsx`
   - `onSlashSubmit` in `packages/plugin/src/tui.ts` AND `packages/tui/src/plugin/command-shim.ts`
   - `children` in `packages/plugin/src/tui.ts` AND `packages/tui/src/plugin/adapters.tsx`
2. `bun typecheck` green in `packages/plugin`, `packages/tui`, `packages/opencode`, `packages/core`.
3. Targeted tests from package dirs (never repo root): `test/session/compaction.test.ts`, `test/session/env-snapshot.test.ts`, `test/session/overflow.test.ts`, `test/command/claude-commands.test.ts`, `test/config/markdown.test.ts`, `test/fixture/tui-plugin.ts` consumers.
4. Smoke-test plugins: launch TUI with `opencode-rich-footer` (footer renders, subagent stats), `opencode-model-router` (`delegate` tool + config mutation), `opencode-anthropic-fix` (summarize hook fires on compaction), `opencode-telegram-plugin` (events flow; `_client.getConfig()` still resolves).
5. If upstream renamed/moved hook types (e.g. `packages/plugin/src/index.ts` refactors), re-apply fork additions in the new location rather than keeping stale copies.
