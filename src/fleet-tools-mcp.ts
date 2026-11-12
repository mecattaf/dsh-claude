import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, TextBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
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
 *  shell, plugin manager or Herdr never cross. The default admits the
 *  `orchestrator_*` tools too: dsh-superagent's main Session and workers call
 *  theirs through this bridge. */
export const DEFAULT_BRIDGED_TOOLS: readonly string[] = ['mnemon_', 'jev_', 'orchestrator_']
const UNSUPPORTED_CONTENT_TEXT = 'This DSH utility bridge supports text results only.'

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
    + 'A write requires its final receipt. Jev tools use an offline synthetic mock, not a real decision model.\n'
    + JSON.stringify(Object.fromEntries(forms))
  return typeof prompt === 'string'
    ? `${context}\n\n${prompt}`
    : [{ type: 'text', text: context }, ...prompt]
}

/** One bridged call's result, as the registry renders it. */
type BridgedResult = { content: readonly ContentBlock[]; isError?: boolean }

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
  const settled = await (tools.execute as unknown as (input: unknown) => Promise<unknown>)(input)
  const results = (settled as { results?: readonly { callId: ToolCallId; result: BridgedResult }[] }).results
  if (!Array.isArray(results)) return settled as BridgedResult
  const own = results.find(entry => entry.callId === call.callId) ?? results[0]
  if (own === undefined) throw new Error(`DSH tool ${call.name} settled without a result`)
  return own.result
}

/**
 * The DSH utilities the Claude session may call, as MCP tool definitions.
 *
 * The registry validates and renders the result and applies its normal
 * pre/guard/post policies. These utilities render text today; DSH image blocks
 * hold attachment references, not MCP image bytes, so a future provider that
 * returns another content kind fails explicitly.
 */
export function dshToolDefinitions(
  agent: Agent,
  lifetime: AbortSignal,
  warn: (message: string) => void = () => {},
  bridged: readonly string[] = DEFAULT_BRIDGED_TOOLS,
): SdkMcpToolDefinition[] {
  const tools: ToolRuntime = agent.ctx.tools
  return tools.schemas(agent)
    .filter(({ name }) => bridged.some(prefix => name.startsWith(prefix)))
    .flatMap(({ name, description, parameters }) => {
      // One tool the bridge cannot represent is left out of this Session,
      // with a warning, rather than failing every turn of it.
      let shape: Record<string, z.ZodType> | undefined
      try {
        shape = (z.fromJSONSchema(parameters) as z.ZodObject<Record<string, z.ZodType>>).shape
      } catch (error) {
        warn(`dsh-claude: DSH tool ${name} is not bridged: its parameters are not a schema the bridge reads (${error instanceof Error ? error.message : String(error)})`)
        return []
      }
      if (shape === undefined) {
        warn(`dsh-claude: DSH tool ${name} is not bridged: an MCP tool takes object arguments`)
        return []
      }
      return [tool(name, description, shape, async (args, extra) => {
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
      })]
    })
}

export function createDshToolsMcpServer(
  agent: Agent,
  lifetime: AbortSignal,
  warn?: (message: string) => void,
  bridged?: readonly string[],
) {
  return createSdkMcpServer({
    name: 'dsh',
    version: '1.0.0',
    tools: dshToolDefinitions(agent, lifetime, warn, bridged),
  })
}
