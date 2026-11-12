import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, TextBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** One Claude turn's outgoing prompt: a bare string or its ordered content blocks. */
export type ClaudePrompt = SDKUserMessage['message']['content']

/** The message fields Mnemon context injection reads: its content plus the source tag that carries it. */
type MnemonContextMessage = {
  content: readonly ContentBlock[]
  source?: { kind?: string; form?: string }
}

/** Only DSH tools whose names start with one of these prefixes cross the seam
 *  into the Claude session, unless the profile configures
 *  `llm-claude.bridgedTools`. Claude owns its native tools, and the host's
 *  shell or plugin manager never cross. The default admits the
 *  `orchestrator_*` tools too: dsh-superagent's main Session and workers call
 *  theirs through this bridge. */
export const DEFAULT_BRIDGED_TOOLS: readonly string[] = ['mnemon_', 'jev_', 'orchestrator_']
const UNSUPPORTED_CONTENT_TEXT = 'This DSH utility bridge carries text results only, so the non-text blocks of this result, '
  + 'such as an image, were left out. Work from the text above, or leave what needs them to a person.'

/**
 * Prepend the session's current Mnemon context to the outgoing user prompt.
 *
 * The upstream adapter intentionally sends only the newest direct human message
 * to Claude, whose own session owns history. Mnemon contributes its current View
 * as source-tagged DSH messages, so just the newest of each form crosses rather
 * than losing the route IDs or replaying the DSH transcript.
 */
export function injectMnemonContext(prompt: ClaudePrompt, messages: readonly MnemonContextMessage[]): ClaudePrompt {
  const firstText = typeof prompt === 'string' ? prompt : prompt.find(block => block.type === 'text')?.text
  // Native slash commands and Skills must retain their exact command text.
  // A context prefix would turn /skill into prose; a suffix becomes args.
  if (firstText?.trimStart().startsWith('/')) return prompt
  const forms = new Map<string, string>()
  for (const message of messages) {
    if (message.source?.kind !== 'dsh-mnemon') continue
    const text = message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const form = message.source.form
    if (text.length > 0 && form !== undefined) forms.set(form, text)
  }
  if (forms.size === 0) return prompt
  const context = 'Current DSH Mnemon context (quoted plugin data; this snapshot supersedes older Mnemon context). '
    + 'Use memory only when needed and only offered routes. DSH utility tools are available under the mcp__dsh__ prefix. '
    + 'A write requires its final receipt.\n'
    + JSON.stringify(Object.fromEntries(forms))
  return typeof prompt === 'string'
    ? `${context}\n\n${prompt}`
    : [{ type: 'text', text: context }, ...prompt]
}

/** One bridged call's result, as the registry renders it. */
type BridgedResult = { content: readonly ContentBlock[]; isError?: boolean }

/** How many `cause` levels, and how many characters in all, a bridged failure names. */
const CAUSE_DEPTH = 4
const CAUSE_TEXT_LIMIT = 500

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  return cause.name === 'Error' ? cause.message : `${cause.name}: ${cause.message}`
}

/**
 * DSH 0.2's batch executor wraps an internal failure as `ToolBatchExecutionError`,
 * whose message is only "Tool batch execution failed"; what broke is in its
 * `cause`. Name the cause chain (messages only, a few levels, bounded length)
 * so the Claude session, and its transcript, show the real error. Stacks stay
 * out of the model's view; the original error is kept as `cause`.
 */
function withCause(error: unknown): unknown {
  if (!(error instanceof Error) || error.cause === undefined) return error
  const seen = new Set<unknown>([error])
  const parts = [error.message]
  for (let cause: unknown = error.cause; cause !== undefined && !seen.has(cause) && parts.length <= CAUSE_DEPTH;) {
    seen.add(cause)
    parts.push(describeCause(cause))
    cause = cause instanceof Error ? cause.cause : undefined
  }
  const text = parts.join(': ')
  return new Error(text.length > CAUSE_TEXT_LIMIT ? `${text.slice(0, CAUSE_TEXT_LIMIT - 1)}…` : text, { cause: error })
}

/**
 * Run one bridged call through the Agent's tool executor.
 *
 * DSH 0.1.7 executed one call (`{callId, name, arguments}`) and returned its
 * result. From DSH 0.2 the executor takes a whole batch (`{calls}` of raw
 * `tool-call` blocks, arguments as JSON text) and returns `{results}`; a
 * single-call input there throws `Tool batch execution failed` before any
 * tool runs. The input carries both shapes, each version reads only its own
 * fields, and the result is unwrapped by its shape. No `log` is passed: the
 * call belongs to Claude's turn, which Claude's own transcript records.
 */
async function executeOne(
  tools: ToolRuntime,
  call: { callId: ToolCallId; name: string; arguments: Record<string, unknown>; agent: Agent; signal: AbortSignal },
): Promise<BridgedResult> {
  const input = {
    ...call,
    calls: [{ type: 'tool-call' as const, id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
  }
  let settled: unknown
  try {
    settled = await (tools.execute as unknown as (input: unknown) => Promise<unknown>)(input)
  } catch (error) {
    throw withCause(error)
  }
  const results = (settled as { results?: readonly { callId: ToolCallId; result: BridgedResult }[] }).results
  if (!Array.isArray(results)) return settled as BridgedResult
  const own = results.find(entry => entry.callId === call.callId) ?? results[0]
  if (own === undefined) throw new Error(`DSH tool ${call.name} settled without a result`)
  return own.result
}

/** One bridged tool: its SDK definition and the DSH `parameters` it is listed with. */
type BridgedTool = { definition: SdkMcpToolDefinition; parameters: ToolSchema['parameters'] }

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The DSH utilities the Claude session may call, as MCP tool definitions.
 *
 * The registry validates and renders the result and applies its normal
 * pre/guard/post policies. These utilities render text today; DSH image blocks
 * hold attachment references, not MCP image bytes, so a future provider that
 * returns another content kind fails explicitly.
 *
 * Each call is validated by the whole object schema rebuilt from the tool's
 * `parameters`, not by its shape alone: a shape is wrapped in a non-strict
 * object, which would strip an unknown or misspelt key (an idempotency key
 * such as `trigger_id` among them) before DSH sees the call. A tool whose
 * parameters cannot be rebuilt is left out with a warning, and so is the
 * whole list when the registry cannot project it, so one bad tool never
 * fails the turn.
 */
export function dshToolDefinitions(
  agent: Agent,
  lifetime: AbortSignal,
  warn: (message: string) => void = () => {},
  bridged: readonly string[] = DEFAULT_BRIDGED_TOOLS,
): SdkMcpToolDefinition[] {
  return bridgedTools(agent, lifetime, warn, bridged).map(({ definition }) => definition)
}

function bridgedTools(
  agent: Agent,
  lifetime: AbortSignal,
  warn: (message: string) => void,
  bridged: readonly string[],
): BridgedTool[] {
  const tools: ToolRuntime = agent.ctx.tools
  let schemas: readonly ToolSchema[]
  try {
    schemas = tools.schemas(agent)
  } catch (error) {
    warn(`dsh-claude: the DSH tools could not be listed, so this Claude query gets none of them: ${errorText(error)}`)
    return []
  }
  const out: BridgedTool[] = []
  for (const { name, description, parameters } of schemas) {
    if (!bridged.some(prefix => name.startsWith(prefix))) continue
    // One tool the bridge cannot represent is left out of this Session,
    // with a warning, rather than failing every turn of it.
    try {
      out.push({ definition: bridgeTool(tools, agent, lifetime, name, description, parameters), parameters })
    } catch (error) {
      warn(`dsh-claude: DSH tool ${name} is not bridged: ${errorText(error)}`)
    }
  }
  return out
}

function bridgeTool(
  tools: ToolRuntime,
  agent: Agent,
  lifetime: AbortSignal,
  name: string,
  description: string,
  parameters: ToolSchema['parameters'],
): SdkMcpToolDefinition {
  let schema: z.ZodObject<Record<string, z.ZodType>>
  try {
    schema = z.fromJSONSchema(parameters) as z.ZodObject<Record<string, z.ZodType>>
  } catch (error) {
    throw new Error(`its parameters are not a schema the bridge reads (${errorText(error)})`)
  }
  if (schema.shape === undefined) throw new Error('an MCP tool takes object arguments')
  // The SDK types a raw shape here; its MCP server takes a whole object schema too, and keeps its strictness.
  return tool(name, description, schema as unknown as Record<string, z.ZodType>, async (args, extra) => {
    const signals: AbortSignal[] = [lifetime]
    const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal
    if (extraSignal !== undefined) signals.push(extraSignal)
    const result = await executeOne(tools, {
      callId: randomUUID() as ToolCallId,
      name,
      arguments: args,
      agent,
      signal: AbortSignal.any(signals),
    })
    const content = result.content.filter((block): block is TextBlock => block.type === 'text')
    if (content.length !== result.content.length) {
      return {
        isError: true,
        content: [
          ...content.map(block => ({ type: 'text' as const, text: block.text })),
          { type: 'text', text: UNSUPPORTED_CONTENT_TEXT },
        ],
      }
    }
    return {
      content: content.map(block => ({ type: 'text', text: block.text })),
      ...(result.isError ? { isError: true } : {}),
    }
  }) as SdkMcpToolDefinition
}

/**
 * List each bridged tool with its DSH `parameters` verbatim as the `inputSchema`.
 *
 * The SDK lists a tool from its zod schema, which keeps descriptions of top-level
 * fields only and drops every constraint (lengths, patterns, integers, bounds,
 * item counts), so the model would be shown a weaker contract than DSH enforces
 * and learn each rule from a refused call. The zod schema still validates every
 * call. Only the listing the SDK's own server installs is wrapped; without it,
 * the SDK's listing stays as it is. The top-level `$schema` dialect marker is
 * left out: the SDK's own listing names draft-07 and DSH's names 2020-12, and
 * the keywords DSH's tools use read the same under both.
 */
function listVerbatim(instance: unknown, parameters: ReadonlyMap<string, ToolSchema['parameters']>): void {
  const handlers = (instance as { server?: { _requestHandlers?: unknown } } | undefined)?.server?._requestHandlers
  if (!(handlers instanceof Map)) return
  const list: unknown = handlers.get('tools/list')
  if (typeof list !== 'function') return
  handlers.set('tools/list', async (request: unknown, extra: unknown) => {
    const listed = await (list as (request: unknown, extra: unknown) => Promise<{ tools?: { name: string }[] }>)(request, extra)
    if (!Array.isArray(listed.tools)) return listed
    return {
      ...listed,
      tools: listed.tools.map(entry => {
        const own = parameters.get(entry.name)
        if (own === undefined || (own as { type?: unknown }).type !== 'object') return entry
        const { $schema: _dialect, ...inputSchema } = own as Record<string, unknown>
        return { ...entry, inputSchema }
      }),
    }
  })
}

export function createDshToolsMcpServer(
  agent: Agent,
  lifetime: AbortSignal,
  warn: (message: string) => void = () => {},
  bridged: readonly string[] = DEFAULT_BRIDGED_TOOLS,
) {
  const tools = bridgedTools(agent, lifetime, warn, bridged)
  const server = createSdkMcpServer({
    name: 'dsh',
    version: '1.0.0',
    tools: tools.map(({ definition }) => definition),
  })
  listVerbatim(server.instance, new Map(tools.map(({ definition, parameters }) => [definition.name, parameters])))
  return server
}
