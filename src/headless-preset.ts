import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { CLAUDE_CODE_PRESET_ID } from './constants.ts'

/**
 * Binds a preset to each top-level Agent its Host created without one.
 *
 * Only the web and API session controllers mount a preset when they create an
 * Agent. The `dsh headless` one-shot runner composes none, so under it the
 * `claude` provider refuses every turn ("available only to the claude
 * preset"). This plugin selects the configured preset on `agent/created`
 * through `agentPresets.select`, the registry method the Client's preset
 * picker calls; the selection is logged as `agent-preset/selected` before
 * the first turn. It is opt-in: a profile inserts the row, together with an
 * `agent-preset-registry` row, which the headless bundle does not load.
 *
 * Insert it only in a profile whose default model is served by the bound
 * preset: the `claude` preset routes every request to the `claude` provider.
 */

export const name = 'dsh-claude-headless-preset'
export const inject = ['agents', 'agentPresets']

export interface Config {
  /** Preset bound to a top-level Agent created without one. */
  preset?: string
}

export const Config: z<Config> = z.object({
  preset: z.string().default(CLAUDE_CODE_PRESET_ID),
})

export function apply(ctx: Context, config: Config = {}): void {
  const preset = config.preset ?? CLAUDE_CODE_PRESET_ID
  ctx.on('agent/created', async ({ agent }) => {
    // A subagent joins the revision its parent retained (composeFrom); one
    // under a preset-free parent stays preset-free, like its parent's world.
    if ((agent.session.header.delegationDepth ?? 0) > 0) return undefined
    // A Host that composes presets already mounted this Agent's.
    if (ctx.agentPresets.composedPreset(agent.ctx) !== undefined) return undefined
    await ctx.agentPresets.select(agent, preset)
    return undefined
  })
}
