import { s as redactText } from "./events-D0EPM8HY.mjs";
//#region src/command-bridge.ts
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_HINT_CHARS = 120;
/** DSH registry names reject `:`, but plugin-qualified Claude skills carry it
*  (e.g. `awesome-skills:ci-deploy`). Derive a registry-safe public name while
*  forwarding keeps the exact Claude-side name. */
function registryName(claudeName) {
	if (COMMAND_NAME.test(claudeName)) return claudeName;
	const short = claudeName.includes(":") ? claudeName.slice(claudeName.lastIndexOf(":") + 1) : void 0;
	if (short !== void 0 && COMMAND_NAME.test(short)) return short;
	const sanitized = claudeName.replaceAll(":", "-").toLowerCase();
	return COMMAND_NAME.test(sanitized) ? sanitized : void 0;
}
/**
* Names registered as CLIENT-side commandUi contributions (not host
* commands). The DSH web command palette fails its whole command group when
* a host command name equals a contribution name
* ("contribution /model collides with a host command"), so these can never
* be registered by this bridge. Keep in sync with the client bundles:
* dsh-client-ui-model-selection registers "model".
*/
const CLIENT_CONTRIBUTION_NAMES = /* @__PURE__ */ new Set(["model"]);
/**
* Cordis service name the preset route provides (behind an entry-local
* isolate realm, so each session gets its own instance) and the host reads
* back with the agent-preset registry's `serviceFor(agent, name)`
* — the supported cross-scope read for callers that already hold the agent.
*/
const CLAUDE_COMMANDS_SERVICE = "claudeCommands";
function bounded(value, maxChars) {
	return redactText(value, maxChars);
}
function projectClaudeCommands(catalog, target) {
	const reservedNames = new Set(target.list().map((command) => command.name));
	for (const name of CLIENT_CONTRIBUTION_NAMES) reservedNames.add(name);
	const assigned = /* @__PURE__ */ new Set();
	const views = [];
	for (const command of catalog) {
		const names = [command.name, ...command.aliases ?? []];
		const commandBases = /* @__PURE__ */ new Set();
		for (const claudeName of names) {
			const base = registryName(claudeName);
			if (base === void 0 || commandBases.has(base)) continue;
			commandBases.add(base);
			let publicName = base;
			let prefixed = false;
			if (reservedNames.has(publicName) || assigned.has(publicName)) {
				publicName = `claude-${base}`;
				prefixed = true;
			}
			if (!COMMAND_NAME.test(publicName) || reservedNames.has(publicName) || assigned.has(publicName)) continue;
			const description = bounded(command.description || `Claude Code /${command.name}`, MAX_DESCRIPTION_CHARS);
			const hint = bounded(command.argumentHint ?? "", MAX_HINT_CHARS);
			views.push({
				publicName,
				claudeName,
				description,
				...hint.length === 0 ? {} : { hint },
				prefixed
			});
			assigned.add(publicName);
		}
	}
	return views;
}
//#endregion
export { projectClaudeCommands as n, CLAUDE_COMMANDS_SERVICE as t };

//# sourceMappingURL=command-bridge-DlhlGYJ6.mjs.map