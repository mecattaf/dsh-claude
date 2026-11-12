import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, TextBlock, ToolCallId } from '@deepseek-ai/dsh-llm'

const UNSUPPORTED_CONTENT_TEXT = 'This DSH tool bridge supports text results only.'

/**
 * True when a profile's `dshTools` list admits the DSH tool `name`: an entry
 * is an exact tool name, or a name prefix ending in `*`. Claude Code owns its
 * own tools, so nothing crosses unless the profile names it.
 */
export function admitsDshTool(patterns: readonly string[], name: string): boolean {
  return patterns.some(pattern => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
}

/** One call's result, as the DSH tool registry renders it. */
type DshToolResult = { content: readonly ContentBlock[]; isError?: boolean }

/** What a DSH 0.2 batch executor settles with; DSH 0.1.7 returns the result itself. */
type DshToolBatchResult = { results: readonly { callId: ToolCallId; result: DshToolResult }[] }

function isBatchResult(settled: unknown): settled is DshToolBatchResult {
  return typeof settled === 'object' && settled !== null && Array.isArray((settled as { results?: unknown }).results)
}

/**
 * DSH 0.2's batch executor reports an internal failure only as "Tool batch
 * execution failed" and keeps what broke in `cause`; name it, so the Claude
 * session and whoever reads its transcript see the real error.
 */
function withCause(error: unknown): unknown {
  if (!(error instanceof Error) || error.cause === undefined) return error
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
  return new Error(`${error.message}: ${cause}`, { cause: error })
}

/**
 * Run one call through the Agent's tool executor, on either executor API.
 *
 * DSH 0.1.7 executes one call, `{callId, name, arguments}`, and returns its
 * result. DSH 0.2 executes a batch, `{calls}` of `tool-call` blocks whose
 * arguments are JSON text, and returns `{results}`; given the single-call
 * shape it fails with "Tool batch execution failed" before any tool runs.
 * The Host ships no type declarations, so a typecheck cannot tell which one
 * is running. The input therefore carries both shapes, since each API reads
 * only its own fields, and the settled value is unwrapped by its shape. No
 * `log` is passed: the call belongs to Claude's turn, which Claude's own
 * transcript records.
 */
async function executeDshTool(
  tools: ToolRuntime,
  call: { callId: ToolCallId; name: string; arguments: Record<string, unknown>; agent: Agent; signal: AbortSignal },
): Promise<DshToolResult> {
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
  if (!isBatchResult(settled)) return settled as DshToolResult
  // The batch holds this one call, so it settles with one result.
  const [own] = settled.results
  if (own === undefined) throw new Error(`DSH tool ${call.name} settled without a result`)
  return own.result
}

/**
 * The listed DSH tools of the Agent's registry, as MCP tool definitions.
 *
 * The registry validates the arguments, applies its normal policies and
 * renders the result. Text results cross as MCP text; DSH image blocks hold
 * attachment references rather than image bytes, so any other content kind
 * comes back as an explicit tool error.
 */
export function dshToolDefinitions(agent: Agent, lifetime: AbortSignal, patterns: readonly string[]): SdkMcpToolDefinition[] {
  const tools: ToolRuntime = agent.ctx.tools
  return tools.schemas(agent)
    .filter(({ name }) => admitsDshTool(patterns, name))
    .map(({ name, description, parameters }) => {
      const schema = z.fromJSONSchema(parameters) as z.ZodObject<Record<string, z.ZodType>>
      const shape = schema.shape
      if (shape === undefined) throw new Error(`DSH tool ${name} requires object arguments`)
      return tool(name, description, shape, async (args, extra) => {
        const signals: AbortSignal[] = [lifetime]
        const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal
        if (extraSignal !== undefined) signals.push(extraSignal)
        const result = await executeDshTool(tools, {
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
      })
    })
}

/** The in-process `dsh` MCP server; Claude Code sees its tools as `mcp__dsh__<name>`. */
export function createDshToolsMcpServer(agent: Agent, lifetime: AbortSignal, patterns: readonly string[]) {
  return createSdkMcpServer({
    name: 'dsh',
    version: '1.0.0',
    tools: dshToolDefinitions(agent, lifetime, patterns),
  })
}
