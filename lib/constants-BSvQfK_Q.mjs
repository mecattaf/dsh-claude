//#region src/constants.ts
const CLAUDE_CODE_PROVIDER = "claude";
const CLAUDE_CODE_PRESET_ID = "claude";
const CLAUDE_CODE_PROVIDER_IDS = [CLAUDE_CODE_PROVIDER];
const CLAUDE_SESSION_BOUND_EVENT = "claude-code/session-bound";
const CLAUDE_ACTIVITY_EVENT = "claude-code/activity";
const CLAUDE_TASKS_EVENT = "claude-code/tasks";
/** Claude's subagent dispatch tools; rendered as plugin-owned group cards
*  gathering subagent activity instead of native tool cards. */
const TASK_TOOL_NAMES = /* @__PURE__ */ new Set(["Task", "Agent"]);
const SDK_VERSION = "0.3.247";
/** System-message subtypes the CLI streams as progress telemetry rather than
*  lifecycle evidence.
*
*  `thinking_tokens` arrives once per estimated thinking-token chunk — the SDK
*  documents it as "approximate progress for spinners/pills, not the
*  authoritative billed output_tokens" — so one extended-thinking step emits
*  tens of thousands of them. The transcript never draws a plain status row,
*  and each durable row costs a full sidecar rewrite, so these are consumed as
*  progress and kept out of the activity log. */
const CLAUDE_PROGRESS_SUBTYPES = /* @__PURE__ */ new Set(["thinking_tokens"]);
/** Durable status title this package writes for a system subtype. Shared by the
*  writer and by the filter that drops a progress subtype's rows, so the two can
*  never drift apart. */
function claudeStatusTitle(subtype) {
	return `Claude Code ${subtype.replaceAll("_", " ")}`;
}
/** Title prefix this package gives a message type it does not handle yet. Shared
*  by the writer and by the projection prune, so a notice row can be recognized
*  without re-deriving the template. */
const CLAUDE_UNKNOWN_MESSAGE_PREFIX = "Unknown Claude SDK message: ";
/** Cordis service this package publishes so a steered message can reach the
*  turn a Claude session is running. That turn owns the only process that can
*  read it into Claude at the next model step. */
const CLAUDE_STEERING_SERVICE = "claudeSteering";
const CLAUDE_DOCTOR_PATH = "/plugins/dsh-claude/doctor";
const CLAUDE_CLIENT_DIAGNOSTICS_PATH = "/plugins/dsh-claude/client-diagnostics";
const CLAUDE_UPDATE_CHECK_PATH = "/plugins/dsh-claude/update/check";
const CLAUDE_USAGE_PATH = "/plugins/dsh-claude/usage";
const CLAUDE_UPDATE_PATH = "/plugins/dsh-claude/update";
const CLAUDE_PROJECTION_PATH = "/plugins/dsh-claude/projection";
const CLAUDE_GLOBAL_SETTINGS_PATH = "/plugins/dsh-claude/settings/global";
const CLAUDE_REPOSITORY_SETUP_PATH = "/plugins/dsh-claude/repository/setup";
const CLAUDE_REPOSITORY_ACTION_PATH = "/plugins/dsh-claude/repository/action";
const CLAUDE_REVIEW_COMMENT_PATH = "/plugins/dsh-claude/review-comments";
const CLAUDE_REPOSITORY_FEEDBACK_PATH = "/plugins/dsh-claude/repository/feedback";
const CLAUDE_REPOSITORY_FILE_PATH = "/plugins/dsh-claude/repository/file";
const CLAUDE_JIRA_PATH = "/plugins/dsh-claude/jira";
const CLAUDE_ASK_PATH = "/plugins/dsh-claude/ask";
const CLAUDE_REWIND_PATH = "/plugins/dsh-claude/rewind";
const CLAUDE_BACKGROUND_TASK_PATH = "/plugins/dsh-claude/background-task";
const CLAUDE_PERMISSION_MODE_PATH = "/plugins/dsh-claude/permission-mode";
const CLAUDE_PLAN_FEEDBACK_PATH = "/plugins/dsh-claude/plan/feedback";
/** Title of the transcript row that shows the reviewer's own plan notes; the
*  renderer keys its label on it. */
const PLAN_FEEDBACK_TITLE = "Plan sent back for changes";
const CLAUDE_PROMPTS_PATH = "/plugins/dsh-claude/prompts";
const CLAUDE_PROMPT_NAME_PATH = "/plugins/dsh-claude/prompts/name";
const CLAUDE_PROMPT_REFINE_PATH = "/plugins/dsh-claude/prompts/refine";
const CLAUDE_RENDER_MODES = ["plugin", "native"];
const DEFAULT_CLAUDE_RENDER_MODE = "plugin";
function isClaudeRenderMode(value) {
	return value === "plugin" || value === "native";
}
const CLAUDE_PROSE_MODES = ["plain", "enhanced"];
const DEFAULT_CLAUDE_PROSE_MODE = "plain";
function isClaudeProseMode(value) {
	return value === "plain" || value === "enhanced";
}
/** Title of the activity an SDK `api_retry` notice becomes. Shared because the
*  Client folds a run of them into one row and has only the title to go on. */
const API_RETRY_TITLE = "Claude API retry";
//#endregion
export { CLAUDE_UNKNOWN_MESSAGE_PREFIX as A, isClaudeProseMode as B, CLAUDE_REPOSITORY_FILE_PATH as C, CLAUDE_SESSION_BOUND_EVENT as D, CLAUDE_REWIND_PATH as E, DEFAULT_CLAUDE_RENDER_MODE as F, PLAN_FEEDBACK_TITLE as I, SDK_VERSION as L, CLAUDE_UPDATE_PATH as M, CLAUDE_USAGE_PATH as N, CLAUDE_STEERING_SERVICE as O, DEFAULT_CLAUDE_PROSE_MODE as P, TASK_TOOL_NAMES as R, CLAUDE_REPOSITORY_FEEDBACK_PATH as S, CLAUDE_REVIEW_COMMENT_PATH as T, isClaudeRenderMode as V, CLAUDE_PROMPT_NAME_PATH as _, CLAUDE_CLIENT_DIAGNOSTICS_PATH as a, CLAUDE_RENDER_MODES as b, CLAUDE_CODE_PROVIDER_IDS as c, CLAUDE_JIRA_PATH as d, CLAUDE_PERMISSION_MODE_PATH as f, CLAUDE_PROMPTS_PATH as g, CLAUDE_PROJECTION_PATH as h, CLAUDE_BACKGROUND_TASK_PATH as i, CLAUDE_UPDATE_CHECK_PATH as j, CLAUDE_TASKS_EVENT as k, CLAUDE_DOCTOR_PATH as l, CLAUDE_PROGRESS_SUBTYPES as m, CLAUDE_ACTIVITY_EVENT as n, CLAUDE_CODE_PRESET_ID as o, CLAUDE_PLAN_FEEDBACK_PATH as p, CLAUDE_ASK_PATH as r, CLAUDE_CODE_PROVIDER as s, API_RETRY_TITLE as t, CLAUDE_GLOBAL_SETTINGS_PATH as u, CLAUDE_PROMPT_REFINE_PATH as v, CLAUDE_REPOSITORY_SETUP_PATH as w, CLAUDE_REPOSITORY_ACTION_PATH as x, CLAUDE_PROSE_MODES as y, claudeStatusTitle as z };

//# sourceMappingURL=constants-BSvQfK_Q.mjs.map