import { V as isClaudeRenderMode } from "./constants-BSvQfK_Q.mjs";
//#region src/events.ts
const SECRET_KEY = /(?:^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key|env|environ|environment)(?:$|[_-])/i;
const MAX_SUMMARY_CHARS = 1e3;
/** A reasoning block gets its own, larger bound.
*
*  The generic budget is a row's summary: a line describing a tool. Thinking is
*  the one summary a reader reads as prose, and at 1,000 characters the median
*  row was exactly at the cap, so more than half of what Claude reasoned was a
*  fragment that stopped mid-sentence. The bound still exists (a step can think
*  for tens of thousands of characters, and this is a durable document), just
*  wide enough to hold a thought. */
const MAX_THINKING_CHARS = 4e3;
const MAX_DETAIL_CHARS = 4e3;
const MAX_TRANSCRIPT_TEXT_CHARS = 64e3;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const REDACTED = "[REDACTED]";
const TRUNCATED = "…[truncated]";
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu;
const BEARER_TOKEN = /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const PREFIXED_TOKEN = /\b(?:sk-(?:ant-|proj-)?|xox[baprs]-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/giu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
/**
* The scheme is bounded on purpose. Unbounded, this pattern is quadratic on any
* long unbroken run that is not a URL: at every offset the greedy scheme run
* scans to the end of the string before failing to find `://`, so redacting a
* 70 kB token took 8 seconds and stalled whatever was normalizing it. No real
* scheme comes close to 32 characters, and the bounded run matches every
* userinfo URL the unbounded one did.
*/
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/[^:\s/@]+:)[^@\s/]+@/giu;
const URL_SECRET_PARAM = /([?&](?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&#\s]+/giu;
function boundText(value, maxChars) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 12))}${TRUNCATED}`;
}
function redactText(value, maxChars = MAX_DETAIL_CHARS) {
	return boundText(value.replace(JWT_TOKEN, REDACTED).replace(PREFIXED_TOKEN, REDACTED).replace(BEARER_TOKEN, `$1${REDACTED}`).replace(URL_USERINFO, `$1${REDACTED}@`).replace(URL_SECRET_PARAM, `$1${REDACTED}`).replace(SECRET_ASSIGNMENT, `$1${REDACTED}`), maxChars);
}
function redactValue(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
	if (depth > MAX_DEPTH) return "[max-depth]";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return redactText(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
	if (value instanceof Error) return {
		name: value.name,
		message: redactText(value.message, MAX_SUMMARY_CHARS)
	};
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
			if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
			return items;
		}
		const result = {};
		const entries = Object.entries(value);
		for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) result[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
		if (entries.length > MAX_OBJECT_KEYS) result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
		return result;
	} finally {
		seen.delete(value);
	}
}
function safeDetail(value) {
	if (value === void 0) return void 0;
	const redacted = redactValue(value);
	if (typeof redacted === "string") return boundText(redacted, MAX_DETAIL_CHARS);
	return boundJson(redacted, MAX_DETAIL_CHARS);
}
/**
* Serialize within `maxChars` and still parse. Cutting the serialized text
* mid-way left readers nothing: an `Agent` call's long `prompt` swallowed the
* `name` behind it, so the roster lost the teammate's name. Instead the
* longest top-level string gives way, repeatedly, and every other field
* survives whole. Only a value with no such string to trim falls back to a cut.
*/
function boundJson(value, maxChars) {
	let text = JSON.stringify(value);
	if (text.length <= maxChars || typeof value !== "object" || value === null || Array.isArray(value)) return boundText(text, maxChars);
	const fields = { ...value };
	while (text.length > maxChars) {
		let longest;
		for (const [key, item] of Object.entries(fields)) if (typeof item === "string" && item.length > 12 && (longest === void 0 || item.length > fields[longest].length)) longest = key;
		if (longest === void 0) return boundText(text, maxChars);
		const item = fields[longest];
		fields[longest] = boundText(item, Math.max(12, item.length - (text.length - maxChars)));
		text = JSON.stringify(fields);
	}
	return text;
}
function normalizeActivity(activity) {
	const normalized = {
		turn: activity.turn,
		step: activity.step,
		ordinal: activity.ordinal,
		kind: activity.kind
	};
	if (activity.phase !== void 0) normalized.phase = activity.phase;
	if (activity.taskId !== void 0) normalized.taskId = redactText(activity.taskId, 128);
	if (activity.toolUseId !== void 0) normalized.toolUseId = redactText(activity.toolUseId, 256);
	if (activity.parentToolUseId !== void 0) normalized.parentToolUseId = redactText(activity.parentToolUseId, 256);
	if (activity.toolName !== void 0) normalized.toolName = redactText(activity.toolName, 256);
	if (activity.title !== void 0) normalized.title = redactText(activity.title, MAX_SUMMARY_CHARS);
	if (activity.summary !== void 0) normalized.summary = redactText(typeof activity.summary === "string" ? activity.summary : safeDetail(activity.summary) ?? "", activity.kind === "thinking" || activity.kind === "steering" ? MAX_THINKING_CHARS : MAX_SUMMARY_CHARS);
	const detail = safeDetail(activity.detail);
	if (detail !== void 0) normalized.detail = detail;
	if (activity.text !== void 0) normalized.text = redactText(activity.text, MAX_TRANSCRIPT_TEXT_CHARS);
	if (activity.isError !== void 0) normalized.isError = activity.isError;
	if (activity.usage !== void 0) normalized.usage = { ...activity.usage };
	if (isClaudeRenderMode(activity.renderer)) normalized.renderer = activity.renderer;
	if (activity.answer === true) normalized.answer = true;
	return normalized;
}
function nonNegativeInteger(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
const MAX_TASKS_PER_SNAPSHOT = 50;
const MAX_TASK_TEXT_CHARS = 300;
const TASK_STATUSES = /* @__PURE__ */ new Set([
	"running",
	"completed",
	"failed",
	"stopped",
	"killed"
]);
function normalizeTaskUsage(input) {
	if (input === void 0) return void 0;
	const usage = {};
	if (input.totalTokens !== void 0) usage.totalTokens = nonNegativeInteger(input.totalTokens);
	if (input.toolUses !== void 0) usage.toolUses = nonNegativeInteger(input.toolUses);
	if (input.durationMs !== void 0) usage.durationMs = nonNegativeInteger(input.durationMs);
	return Object.keys(usage).length === 0 ? void 0 : usage;
}
function normalizeTasksEvent(tasks) {
	return { tasks: tasks.slice(0, MAX_TASKS_PER_SNAPSHOT).map((task) => {
		const usage = normalizeTaskUsage(task.usage);
		return {
			taskId: redactText(String(task.taskId), 128),
			...task.toolUseId === void 0 ? {} : { toolUseId: redactText(String(task.toolUseId), 128) },
			description: redactText(String(task.description), MAX_TASK_TEXT_CHARS),
			status: TASK_STATUSES.has(task.status) ? task.status : "running",
			...task.originTurn === void 0 ? {} : { originTurn: nonNegativeInteger(task.originTurn) },
			...task.subagentType === void 0 ? {} : { subagentType: redactText(task.subagentType, 64) },
			...task.taskType === void 0 ? {} : { taskType: redactText(task.taskType, 64) },
			...task.lastToolName === void 0 ? {} : { lastToolName: redactText(task.lastToolName, 64) },
			...task.summary === void 0 ? {} : { summary: redactText(task.summary, MAX_TASK_TEXT_CHARS) },
			...usage === void 0 ? {} : { usage },
			...task.backgrounded === true ? { backgrounded: true } : {}
		};
	}) };
}
function latestClaudeTasks(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "claude-code/tasks") return event.data;
	}
}
/** Derive the current DSH turn/step; activity ordinals are completed from the sidecar. */
function currentClaudeActivityCursor(events) {
	let turn = 0;
	let step = 0;
	for (const event of events) {
		if (event.type !== "step/start") continue;
		const data = event.data;
		turn = data.turn;
		step = data.step;
	}
	if (turn < 1 || step < 1) throw new Error("dsh-claude: Claude activity requires an open DSH step");
	return {
		turn,
		step,
		nextOrdinal: 0
	};
}
function latestClaudeSessionBinding(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "claude-code/session-bound") return event.data;
	}
}
//#endregion
export { normalizeActivity as a, safeDetail as c, latestClaudeTasks as i, currentClaudeActivityCursor as n, normalizeTasksEvent as o, latestClaudeSessionBinding as r, redactText as s, boundText as t };

//# sourceMappingURL=events-D0EPM8HY.mjs.map