import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/headless-preset.d.ts
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
declare const name = "dsh-claude-headless-preset";
declare const inject: string[];
interface Config {
  /** Preset bound to a top-level Agent created without one. */
  preset?: string;
}
declare const Config: z<Config>;
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=headless-preset.d.mts.map