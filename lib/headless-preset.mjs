import { o as CLAUDE_CODE_PRESET_ID } from "./constants-BSvQfK_Q.mjs";
import { r as isClaudeSelection } from "./preset-model-sync-Bw6IdamY.mjs";
import z from "@deepseek-ai/schemastery";
//#region src/headless-preset.ts
/**
* Binds a preset to each top-level Agent its Host created without one.
*
* Only the web and API session controllers mount a preset when they create an
* Agent. The `dsh headless` one-shot runner composes none, so under it the
* `claude` provider refuses every turn: a preset-free Session is not one
* listed in `llm-claude.presets`. This plugin selects the configured preset
* on `agent/created` through `agentPresets.select`, the registry method the
* Client's preset picker calls; the selection is logged as
* `agent-preset/selected` before the first turn. It is opt-in: a profile
* inserts the row, together with an `agent-preset-registry` row, which the
* headless bundle does not load. Only a newly created Agent is bound: a
* resumed Session keeps what its log records, and the registry locks the
* preset of one that has taken a turn.
*
* Insert it only in a profile whose default model is served by the bound
* preset: the `claude` preset routes every request to the `claude` provider.
* As a backstop, an Agent whose default model is not a Claude one is left
* without the `claude` preset, so it runs on its own provider instead of
* failing every turn under Claude Code.
*/
const name = "dsh-claude-headless-preset";
const inject = ["agents", "agentPresets"];
const Config = z.object({ preset: z.string().default(CLAUDE_CODE_PRESET_ID) });
function apply(ctx, config = {}) {
	const preset = config.preset ?? "claude";
	ctx.on("agent/created", async ({ agent, source }) => {
		if (source !== "startup") return void 0;
		if ((agent.session.header.delegationDepth ?? 0) > 0) return void 0;
		if (ctx.agentPresets.composedPreset(agent.ctx) !== void 0) return void 0;
		const model = ctx.get("agentDefaultModel")?.currentSelection();
		if (preset === "claude" && model !== void 0 && !isClaudeSelection(model)) {
			ctx.logger.info("dsh-claude: left %s without the claude preset: its default model is %s/%s", String(agent.id), model.provider, model.model);
			return;
		}
		await ctx.agentPresets.select(agent, preset);
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=headless-preset.mjs.map