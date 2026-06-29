import { createContext, createEffect, createMemo, createRoot, createSignal, on, useContext, type Accessor, type ParentProps } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import type { ReactiveMatcher } from "@opentui/keymap"
import {
  formatKeyBindings,
  type OpenTuiKeymap,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"

function reactiveMatcherFromSignal(signal: () => boolean): ReactiveMatcher {
  return {
    get: signal,
    subscribe(onChange: () => void) {
      return createRoot((dispose) => {
        createEffect(on(signal, () => onChange(), { defer: true }))
        return dispose
      })
    },
  }
}
import { useTuiConfig } from "../config"

type SlashEntry = {
  display: string
  description?: string
  aliases?: string[]
  onSelect: () => void
}

type CommandPaletteContext = {
  run(command: string): void
  show(): void
  handleSlash(name: string, args: string): boolean
  slashes: Accessor<readonly SlashEntry[]>
  suspend(enabled: boolean): void
  readonly suspended: boolean
  matcher: ReactiveMatcher
}

const COMMAND_PALETTE_DIALOG = "command.palette.show"
const ctx = createContext<CommandPaletteContext>()
type PaletteCommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]

function isVisiblePaletteCommand(entry: PaletteCommandEntry) {
  return entry.command.hidden !== true && entry.command.name !== COMMAND_PALETTE_DIALOG
}

function isSuggestedPaletteCommand(entry: PaletteCommandEntry) {
  const suggested = entry.command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteProvider(props: ParentProps) {
  const dialog = useDialog()
  const keymap = useOpencodeKeymap()
  const [suspendCount, setSuspendCount] = createSignal(0)
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) =>
    keymap
      .getCommandEntries({
        visibility: "reachable",
        namespace: "palette",
      })
      .filter(isVisiblePaletteCommand),
  )

  const run = (command: string) => {
    keymap.dispatchCommand(command)
  }

  const allEntries = useKeymapSelector((keymap: OpenTuiKeymap) =>
    keymap.getCommandEntries({ visibility: "registered" }),
  )

  const slashes = createMemo<SlashEntry[]>(() =>
    allEntries().flatMap((entry) => {
      const slashName = entry.command.slashName
      if (typeof slashName !== "string" || !slashName) return []
      const slashAliases = entry.command.slashAliases
      return {
        display: `/${slashName}`,
        description:
          typeof entry.command.desc === "string"
            ? entry.command.desc
            : typeof entry.command.title === "string"
              ? entry.command.title
              : undefined,
        aliases: Array.isArray(slashAliases)
          ? slashAliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `/${alias}`)
          : undefined,
        onSelect: () => run(entry.command.name),
      }
    }),
  )

  const value: CommandPaletteContext = {
    run,
    handleSlash(name: string, args: string): boolean {
      for (const entry of allEntries()) {
        const cmd = entry.command
        const slashName = cmd.slashName
        if (typeof slashName !== "string" || !slashName) continue
        if (slashName !== name && !(Array.isArray(cmd.slashAliases) && cmd.slashAliases.includes(name))) continue
        const onSlashSubmit = cmd.onSlashSubmit
        if (typeof onSlashSubmit === "function") return (onSlashSubmit as (args: string) => boolean)(args)
        keymap.runCommand(cmd.name)
        return true
      }
      return false
    },
    show() {
      dialog.replace(() => <CommandPaletteDialog run={run} />)
    },
    slashes,
    suspend(enabled: boolean) {
      setSuspendCount((count) => Math.max(0, count + (enabled ? 1 : -1)))
    },
    get suspended() {
      return suspendCount() > 0 || dialog.stack.length > 0
    },
    matcher: reactiveMatcherFromSignal(() => suspendCount() === 0 && dialog.stack.length === 0),
  }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useCommandPalette() {
  const value = useContext(ctx)
  if (!value) throw new Error("CommandPalette context must be used within a CommandPaletteProvider")
  return value
}

function CommandPaletteDialog(props: { run(command: string): void }) {
  const config = useTuiConfig()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const query = {
      namespace: "palette",
    }
    const reachable = keymap
      .getCommandEntries({
        ...query,
        visibility: "reachable",
      })
      .filter(isVisiblePaletteCommand)
    const registeredBindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })

    return reachable.map((entry) => ({
      ...entry,
      bindings: registeredBindings.get(entry.command.name) ?? entry.bindings,
    }))
  })
  const options = createMemo(() =>
    entries().map((entry) => ({
      title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
      description: typeof entry.command.desc === "string" ? entry.command.desc : undefined,
      category: typeof entry.command.category === "string" ? entry.command.category : undefined,
      footer: formatKeyBindings(entry.bindings, config),
      value: entry.command.name,
      suggested: isSuggestedPaletteCommand(entry),
      onSelect: (dialog: DialogContext) => {
        dialog.clear()
        props.run(entry.command.name)
      },
    })),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: "Suggested",
        })),
      ...options(),
    ]
  }

  return <DialogSelect ref={(value: DialogSelectRef<string>) => (ref = value)} title="Commands" options={list()} />
}

export function useCommandSlashes(): Accessor<readonly SlashEntry[]> {
  return useCommandPalette().slashes
}
