import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER, CLAUDE_CODE_PROVIDER_IDS } from './constants.ts'
import { canonicalClaudeModelId } from './model-catalog.ts'

/**
 * Keeps a blank session's model on the side its preset runs: a Claude model
 * under the Claude preset, a non-Claude model under every other one.
 *
 * DSH presets carry no model, and a session's model is a separate selection
 * that also becomes the profile default. Switching presets, or opening a new
 * session after the default was last picked on the other side, would leave
 * the picker on a model the preset cannot use. The last model seen on each
 * side is remembered in memory and restored when a session crosses over.
 */

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface PresetModelSyncDeps {
  /** The session's current selection: its pending pick, else the profile default. */
  currentSelection(sessionId: string): ModelSelection | undefined
  /** Whether this is an ordinary session that has made no model request yet. Only those are touched. */
  isBlank(sessionId: string): boolean
  /** `sessionController.selectModel`, which also keeps the Host's selection cache. */
  selectModel(request: { sessionId: string } & ModelSelection): Promise<unknown>
  /** First model of a non-Claude provider, for when that side was never seen. */
  fallbackOtherModel(): Promise<ModelSelection | undefined>
  /** The Claude model a session starts on when none was seen. */
  defaultClaudeModel(): string
  warn(message: string): void
  /** Presets besides the Claude preset whose Sessions may run on either side.
   *  Their owner picks the model (dsh-superagent seeds each role's model), so
   *  a blank Session under one is never moved. */
  eitherSidePresets?: readonly string[]
}

export function isClaudeSelection(selection: ModelSelection): boolean {
  return (CLAUDE_CODE_PROVIDER_IDS as readonly string[]).includes(selection.provider)
}

export function createPresetModelSync(deps: PresetModelSyncDeps) {
  let lastClaude: ModelSelection | undefined
  let lastOther: ModelSelection | undefined
  const remember = (selection: ModelSelection | undefined): void => {
    if (selection === undefined) return
    if (isClaudeSelection(selection)) lastClaude = selection
    else lastOther = selection
  }

  return {
    remember,
    /** Move the session to its preset's side when it sits on the other one. */
    async sync(sessionId: string, preset: string): Promise<void> {
      if (!deps.isBlank(sessionId)) return
      if (preset !== CLAUDE_CODE_PRESET_ID && deps.eitherSidePresets?.includes(preset) === true) return
      const current = deps.currentSelection(sessionId)
      remember(current)
      const wantsClaude = preset === CLAUDE_CODE_PRESET_ID
      if (current !== undefined && isClaudeSelection(current) === wantsClaude) return
      const target = wantsClaude
        ? lastClaude ?? { provider: CLAUDE_CODE_PROVIDER, model: canonicalClaudeModelId(deps.defaultClaudeModel()) }
        : lastOther ?? await deps.fallbackOtherModel()
      if (target === undefined) return
      try {
        await deps.selectModel({ sessionId, ...target })
      } catch (error) {
        deps.warn(`dsh-claude: could not move session ${sessionId} to ${target.provider}/${target.model} for preset ${preset}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

// About five seconds for a new Agent's preset composition to land. Fixed, not
// configured: the poll only bounds how long an Agent no Host composes is
// watched, and it gives up quietly.
const COMPOSITION_POLL_MS = 200
const COMPOSITION_POLL_ATTEMPTS = 25

/**
 * Waits for a new Agent's preset composition, which lands after
 * `agent/created`: polls briefly and gives up quietly, since an Agent no Host
 * composes a preset for never settles. The read goes through the plugin's
 * injected `agentPresets`, which throws once that plugin context is inactive,
 * so `dispose()` turns every poll still waiting into a no-op. Otherwise a
 * `dsh headless` run that ends inside the window dies on a timer.
 */
export function createCompositionWatch() {
  let disposed = false
  return {
    /** Call `settled` with the preset once `composedPreset` reports one. */
    watch(composedPreset: () => string | undefined, settled: (preset: string) => void): void {
      let attempts = 0
      const check = (): void => {
        if (disposed) return
        const preset = composedPreset()
        if (preset !== undefined) {
          settled(preset)
          return
        }
        if (++attempts < COMPOSITION_POLL_ATTEMPTS) setTimeout(check, COMPOSITION_POLL_MS).unref?.()
      }
      check()
    },
    dispose(): void {
      disposed = true
    },
  }
}
