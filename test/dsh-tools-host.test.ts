import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as nativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { dshToolDefinitions } from '../src/dsh-tools-mcp.ts'

/**
 * The bridge against the host's own tool runtime, not a stub: a Cordis Context
 * with DSH's SystemPrompt, ToolsService and native executor, as a DSH host
 * composes them. A stub only repeats what the bridge assumes about
 * `tools.execute`; this fails when the host's executor contract moves.
 */
async function hostWith(body: (args: Record<string, unknown>) => unknown) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  await ctx.plugin(nativeToolExecutor)
  const ran: Record<string, unknown>[] = []
  ctx.tools.register({
    name: 'orchestrator_read',
    description: 'Read one orchestrator resource.',
    parameters: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: Record<string, unknown>) => {
      ran.push(args)
      return body(args)
    },
  })
  return { agent: { ctx } as unknown as Agent, ran }
}

describe('DSH tools MCP bridge on the host tool runtime', () => {
  it('runs a bridged call through the host executor and returns its rendered result', async () => {
    const { agent, ran } = await hostWith(args => ({ read: args.resource }))
    const [definition] = dshToolDefinitions(agent, new AbortController().signal)
    expect(definition?.name).toBe('orchestrator_read')
    const reply = await definition!.handler({ resource: 'triggers' }, {} as never)
    expect(reply).toEqual({ content: [{ type: 'text', text: '{"read":"triggers"}' }] })
    expect(ran).toEqual([{ resource: 'triggers' }])
  })

  it('returns a failing tool body as an MCP error result, not a rejected call', async () => {
    const { agent } = await hostWith(() => {
      throw new Error('no such trigger')
    })
    const [definition] = dshToolDefinitions(agent, new AbortController().signal)
    const reply = await definition!.handler({ resource: 'triggers' }, {} as never)
    expect(reply).toMatchObject({ isError: true })
    expect(JSON.stringify(reply)).toContain('no such trigger')
  })
})
