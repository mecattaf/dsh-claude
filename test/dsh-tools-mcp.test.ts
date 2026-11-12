import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { admitsDshTool, createDshToolsMcpServer, dshToolDefinitions } from '../src/dsh-tools-mcp.ts'

const schema = (name: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }) => ({
  name,
  description: `DSH tool ${name}`,
  parameters,
})

/** A DSH 0.1.7 registry: `execute` runs one call and returns its result. */
function singleCallAgent(...names: string[]): Agent {
  const tools = {
    schemas: () => names.map(name => schema(name)),
    execute: async (exec: { name: string }) => ({
      content: [{ type: 'text' as const, text: `ran ${exec.name}` }],
      isError: false,
    }),
  }
  return { ctx: { tools } } as unknown as Agent
}

type BatchCall = { type: 'tool-call'; id: string; name: string; arguments: string }

/** A DSH 0.2 registry: `execute` runs a batch of `tool-call` blocks and fails
 *  the whole batch, as DSH's `executeToolBatch` does, when `calls` is missing. */
function batchAgent(
  names: string[],
  run: (call: BatchCall) => { content: { type: 'text'; text: string }[]; isError: boolean },
  seen: unknown[] = [],
): Agent {
  const tools = {
    schemas: () => names.map(name => schema(name, { type: 'object', properties: { resource: { type: 'string' } } })),
    execute: async (input: { calls?: BatchCall[] }) => {
      seen.push(input)
      if (!Array.isArray(input.calls)) {
        throw new Error('Tool batch execution failed', { cause: new TypeError("Cannot read properties of undefined (reading 'map')") })
      }
      return {
        results: input.calls.map(call => ({ callId: call.id, result: run(call) })),
        additionalContexts: [],
        concluded: false,
      }
    },
  }
  return { ctx: { tools } } as unknown as Agent
}

const lifetime = () => new AbortController().signal

describe('DSH tools MCP bridge', () => {
  it('admits a DSH tool by its exact name or by a prefix ending in *', () => {
    expect(admitsDshTool(['memory_*', 'calendar_read'], 'memory_recall')).toBe(true)
    expect(admitsDshTool(['memory_*', 'calendar_read'], 'calendar_read')).toBe(true)
    expect(admitsDshTool(['memory_*', 'calendar_read'], 'calendar_write')).toBe(false)
    expect(admitsDshTool([], 'memory_recall')).toBe(false)
  })

  it('bridges only the DSH tools the profile lists, keeping the rest behind the seam', () => {
    const agent = singleCallAgent('memory_recall', 'memory_write', 'calendar_read', 'bash')
    expect(dshToolDefinitions(agent, lifetime(), ['memory_*', 'calendar_read']).map(({ name }) => name))
      .toEqual(['memory_recall', 'memory_write', 'calendar_read'])
    expect(dshToolDefinitions(agent, lifetime(), [])).toEqual([])
  })

  it('creates the in-process dsh MCP server', () => {
    const server = createDshToolsMcpServer(singleCallAgent('memory_recall'), lifetime(), ['memory_*'])
    expect(server).toMatchObject({ type: 'sdk', name: 'dsh' })
  })

  it('runs a call through a DSH 0.2 batch executor and unwraps its result', async () => {
    const seen: unknown[] = []
    const agent = batchAgent(['memory_read'], call => ({
      content: [{ type: 'text', text: `ran ${call.name} ${call.arguments}` }],
      isError: false,
    }), seen)
    const [definition] = dshToolDefinitions(agent, lifetime(), ['memory_read'])
    const reply = await definition!.handler({ resource: 'notes' }, {} as never)
    expect(reply).toEqual({ content: [{ type: 'text', text: 'ran memory_read {"resource":"notes"}' }] })
    expect(seen).toHaveLength(1)
    expect((seen[0] as { calls: unknown[] }).calls).toEqual([
      { type: 'tool-call', id: expect.any(String), name: 'memory_read', arguments: '{"resource":"notes"}' },
    ])
  })

  it('keeps a DSH 0.2 tool error as an MCP error result', async () => {
    const agent = batchAgent(['memory_read'], () => ({ content: [{ type: 'text', text: 'no such note' }], isError: true }))
    const [definition] = dshToolDefinitions(agent, lifetime(), ['memory_read'])
    expect(await definition!.handler({}, {} as never)).toEqual({ content: [{ type: 'text', text: 'no such note' }], isError: true })
  })

  it('still runs a call through a DSH 0.1.7 single-call executor', async () => {
    const [definition] = dshToolDefinitions(singleCallAgent('memory_recall'), lifetime(), ['memory_recall'])
    expect(await definition!.handler({}, {} as never)).toEqual({ content: [{ type: 'text', text: 'ran memory_recall' }] })
  })

  it('names the cause when a DSH 0.2 batch fails internally', async () => {
    const tools = {
      schemas: () => [schema('memory_read')],
      execute: async () => {
        throw new Error('Tool batch execution failed', { cause: new Error('scheduler lost the call') })
      },
    }
    const [definition] = dshToolDefinitions({ ctx: { tools } } as unknown as Agent, lifetime(), ['memory_read'])
    await expect(definition!.handler({}, {} as never)).rejects.toThrow('Tool batch execution failed: scheduler lost the call')
  })
})
