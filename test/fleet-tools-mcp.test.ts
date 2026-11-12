import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDshToolsMcpServer, dshToolDefinitions, injectMnemonContext } from '../src/fleet-tools-mcp.ts'

const tool = (name: string, description = `DSH utility ${name}`, parameters: Record<string, unknown> = { type: 'object', properties: {} }) => ({
  name,
  description,
  parameters,
})

function agentWith(...names: string[]): Agent {
  const tools = {
    schemas: () => names.map(name => tool(name)),
    execute: async (exec: { name: string }) => ({
      content: [{ type: 'text' as const, text: `ran ${exec.name}` }],
      isError: false,
    }),
  }
  return { ctx: { tools } } as unknown as Agent
}

function lifetime() {
  const controller = new AbortController()
  return { signal: controller.signal, controller }
}

describe('DSH tools MCP bridge', () => {
  it('crosses the mnemon, jev and orchestrator tools into the Claude session', () => {
    const { signal } = lifetime()
    const definitions = dshToolDefinitions(agentWith('orchestrator_route', 'mnemon_recall', 'jev_x', 'shell'), signal)
    expect(definitions.map(({ name }) => name)).toEqual(['orchestrator_route', 'mnemon_recall', 'jev_x'])
  })

  it('keeps the host-owned shell tool behind the seam', () => {
    const { signal } = lifetime()
    const definitions = dshToolDefinitions(agentWith('mnemon_recall', 'host_shell'), signal)
    expect(definitions.map(({ name }) => name)).toEqual(['mnemon_recall'])
  })

  it('creates the in-process dsh MCP server', () => {
    const { signal } = lifetime()
    const server = createDshToolsMcpServer(agentWith('orchestrator_route'), signal)
    expect(server).toMatchObject({ type: 'sdk', name: 'dsh' })
  })

  it('runs a call through a DSH 0.2 batch executor and unwraps its result', async () => {
    const { signal } = lifetime()
    const seen: unknown[] = []
    const tools = {
      schemas: () => [tool('orchestrator_read', 'read', { type: 'object', properties: { resource: { type: 'string' } } })],
      execute: async (input: { calls?: { id: string; name: string; arguments: string }[] }) => {
        seen.push(input)
        if (!Array.isArray(input.calls)) throw new Error('Tool batch execution failed')
        return {
          results: input.calls.map(call => ({
            callId: call.id,
            result: { content: [{ type: 'text' as const, text: `ran ${call.name} ${call.arguments}` }], isError: false },
          })),
          additionalContexts: [],
          concluded: false,
        }
      },
    }
    const [definition] = dshToolDefinitions({ ctx: { tools } } as unknown as Agent, signal)
    const reply = await definition!.handler({ resource: 'triggers' }, {} as never)
    expect(reply).toEqual({ content: [{ type: 'text', text: 'ran orchestrator_read {"resource":"triggers"}' }] })
    expect(seen).toHaveLength(1)
    expect((seen[0] as { calls: unknown[] }).calls).toEqual([
      { type: 'tool-call', id: expect.any(String), name: 'orchestrator_read', arguments: '{"resource":"triggers"}' },
    ])
  })

  it('keeps a DSH 0.2 tool error as an MCP error result', async () => {
    const { signal } = lifetime()
    const tools = {
      schemas: () => [tool('orchestrator_route')],
      execute: async (input: { calls: { id: string }[] }) => ({
        results: [{ callId: input.calls[0]!.id, result: { content: [{ type: 'text' as const, text: 'no such trigger' }], isError: true } }],
        additionalContexts: [],
        concluded: false,
      }),
    }
    const [definition] = dshToolDefinitions({ ctx: { tools } } as unknown as Agent, signal)
    expect(await definition!.handler({}, {} as never)).toEqual({ content: [{ type: 'text', text: 'no such trigger' }], isError: true })
  })

  /** A batch executor that keeps each call's signal and answers with the given blocks. */
  function batchTools(content: readonly { type: string; [field: string]: unknown }[] = [{ type: 'text', text: 'ok' }]) {
    const signals: AbortSignal[] = []
    const tools = {
      schemas: () => [tool('orchestrator_route')],
      execute: async (input: { calls: { id: string }[]; signal: AbortSignal }) => {
        signals.push(input.signal)
        return { results: [{ callId: input.calls[0]!.id, result: { content, isError: false } }], additionalContexts: [], concluded: false }
      },
    }
    return { agent: { ctx: { tools } } as unknown as Agent, signals }
  }

  it('aborts the DSH call when Claude aborts that one tool call', async () => {
    const { signal } = lifetime()
    const { agent, signals } = batchTools()
    const [definition] = dshToolDefinitions(agent, signal)
    const call = new AbortController()
    await definition!.handler({}, { signal: call.signal } as never)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    call.abort()
    expect(signals[0]!.aborted).toBe(true)
  })

  it('aborts the DSH call when the Claude session ends', async () => {
    const { signal, controller } = lifetime()
    const { agent, signals } = batchTools()
    const [definition] = dshToolDefinitions(agent, signal)
    await definition!.handler({}, { signal: new AbortController().signal } as never)
    expect(signals[0]!.aborted).toBe(false)
    controller.abort()
    expect(signals[0]!.aborted).toBe(true)
  })

  it('fails a result that holds a non-text block explicitly, keeping its text', async () => {
    const { signal } = lifetime()
    const { agent } = batchTools([{ type: 'text', text: 'chart below' }, { type: 'image', attachment: 'a1' }])
    const [definition] = dshToolDefinitions(agent, signal)
    expect(await definition!.handler({}, {} as never)).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'chart below' }, { type: 'text', text: 'This DSH utility bridge supports text results only.' }],
    })
  })

  it('still runs a call through a single-call (DSH 0.1.7) executor', async () => {
    const { signal } = lifetime()
    const [definition] = dshToolDefinitions(agentWith('mnemon_recall'), signal)
    expect(await definition!.handler({}, {} as never)).toEqual({ content: [{ type: 'text', text: 'ran mnemon_recall' }] })
  })

  it('leaves a native slash command prompt untouched', () => {
    expect(injectMnemonContext('/skill my-skill', [])).toBe('/skill my-skill')
  })

  it('prefixes the newest Mnemon context before the human prompt', () => {
    const prompt = injectMnemonContext('plan the deploy', [
      { content: [{ type: 'text', text: 'older Mnemon view' }], source: { kind: 'user' } },
      { content: [{ type: 'text', text: 'route-7 wants a rollback' }], source: { kind: 'dsh-mnemon', form: 'view' } },
    ])
    expect(prompt).toBe(`Current DSH Mnemon context (quoted plugin data; this snapshot supersedes older Mnemon context). Use memory only when needed and only offered routes. DSH utility tools are available under the mcp__dsh__ prefix. A write requires its final receipt. Jev tools use an offline synthetic mock, not a real decision model.\n${JSON.stringify({ view: 'route-7 wants a rollback' })}\n\nplan the deploy`)
  })

  it('returns the prompt unchanged when no Mnemon context was offered', () => {
    expect(injectMnemonContext('plan the deploy', [{ content: [{ type: 'text', text: 'nope' }], source: { kind: 'user' } }])).toBe('plan the deploy')
  })
})
