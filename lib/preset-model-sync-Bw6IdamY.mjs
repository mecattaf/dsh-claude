import { c as CLAUDE_CODE_PROVIDER_IDS, o as CLAUDE_CODE_PRESET_ID } from "./constants-BSvQfK_Q.mjs";
import { t as canonicalClaudeModelId } from "./model-catalog-B-BGdmSs.mjs";
//#region src/preset-model-sync.ts
function isClaudeSelection(selection) {
	return CLAUDE_CODE_PROVIDER_IDS.includes(selection.provider);
}
function createPresetModelSync(deps) {
	let lastClaude;
	let lastOther;
	const remember = (selection) => {
		if (selection === void 0) return;
		if (isClaudeSelection(selection)) lastClaude = selection;
		else lastOther = selection;
	};
	return {
		remember,
		/** Move the session to its preset's side when it sits on the other one. */
		async sync(sessionId, preset) {
			if (!deps.isBlank(sessionId)) return;
			if (preset !== "claude" && deps.eitherSidePresets?.includes(preset) === true) return;
			const current = deps.currentSelection(sessionId);
			remember(current);
			const wantsClaude = preset === CLAUDE_CODE_PRESET_ID;
			if (current !== void 0 && isClaudeSelection(current) === wantsClaude) return;
			const target = wantsClaude ? lastClaude ?? {
				provider: "claude",
				model: canonicalClaudeModelId(deps.defaultClaudeModel())
			} : lastOther ?? await deps.fallbackOtherModel();
			if (target === void 0) return;
			try {
				await deps.selectModel({
					sessionId,
					...target
				});
			} catch (error) {
				deps.warn(`dsh-claude: could not move session ${sessionId} to ${target.provider}/${target.model} for preset ${preset}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}
const COMPOSITION_POLL_MS = 200;
const COMPOSITION_POLL_ATTEMPTS = 25;
/**
* Waits for a new Agent's preset composition, which lands after
* `agent/created`: polls briefly and gives up quietly, since an Agent no Host
* composes a preset for never settles. The read goes through the plugin's
* injected `agentPresets`, which throws once that plugin context is inactive,
* so `dispose()` turns every poll still waiting into a no-op. Otherwise a
* `dsh headless` run that ends inside the window dies on a timer.
*/
function createCompositionWatch() {
	let disposed = false;
	return {
		/** Call `settled` with the preset once `composedPreset` reports one. */
		watch(composedPreset, settled) {
			let attempts = 0;
			const check = () => {
				if (disposed) return;
				const preset = composedPreset();
				if (preset !== void 0) {
					settled(preset);
					return;
				}
				if (++attempts < COMPOSITION_POLL_ATTEMPTS) setTimeout(check, COMPOSITION_POLL_MS).unref?.();
			};
			check();
		},
		dispose() {
			disposed = true;
		}
	};
}
//#endregion
export { createPresetModelSync as n, isClaudeSelection as r, createCompositionWatch as t };

//# sourceMappingURL=preset-model-sync-Bw6IdamY.mjs.map