import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDshToolsMcpServer, dshToolDefinitions, injectMnemonContext } from '../src/dsh-tools-mcp.ts'

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

  it('crosses only the tools of the configured prefixes', () => {
    const { signal } = lifetime()
    const definitions = dshToolDefinitions(agentWith('orchestrator_route', 'mnemon_recall', 'notes_find'), signal, undefined, ['notes_'])
    expect(definitions.map(({ name }) => name)).toEqual(['notes_find'])
  })

  it('keeps the host-owned shell tool behind the seam', () => {
    const { signal } = lifetime()
    const definitions = dshToolDefinitions(agentWith('mnemon_recall', 'host_shell'), signal)
    expect(definitions.map(({ name }) => name)).toEqual(['mnemon_recall'])
  })

  it('leaves out, with a warning, a bridged tool whose parameters are not an object schema', () => {
    const { signal } = lifetime()
    const agent = { ctx: { tools: { schemas: () => [tool('orchestrator_odd', 'odd', { type: 'string' }), tool('orchestrator_route')], execute: async () => ({ content: [] }) } } } as unknown as Agent
    const warnings: string[] = []
    const definitions = dshToolDefinitions(agent, signal, message => { warnings.push(message) })
    expect(definitions.map(({ name }) => name)).toEqual(['orchestrator_route'])
    expect(warnings).toEqual([expect.stringContaining('orchestrator_odd is not bridged')])
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
      content: [{ type: 'text', text: 'chart below' }, { type: 'text', text: expect.stringMatching(/text results only.*Work from the text/su) }],
    })
  })

  /** DSH 0.2's `ToolBatchExecutionError` (dsh-tools `types/executor.js`): a fixed message, what broke in `cause`. */
  class ToolBatchExecutionError extends Error {
    constructor(cause: unknown) {
      super('Tool batch execution failed', { cause })
      this.name = 'ToolBatchExecutionError'
    }
  }

  function failingWith(error: unknown): Agent {
    const tools = {
      schemas: () => [tool('orchestrator_eval')],
      execute: async () => { throw error },
    }
    return { ctx: { tools } } as unknown as Agent
  }

  it('names the cause when a DSH 0.2 batch executor fails internally', async () => {
    const { signal } = lifetime()
    const failure = new ToolBatchExecutionError(new TypeError("Cannot read properties of undefined (reading 'map')"))
    const [definition] = dshToolDefinitions(failingWith(failure), signal)
    const error = await definition!.handler({}, {} as never).then(() => undefined, (error: unknown) => error as Error)
    expect(error?.message).toBe("Tool batch execution failed: TypeError: Cannot read properties of undefined (reading 'map')")
    expect(error?.message).not.toMatch(/\n\s+at /)
    expect(error?.cause).toBe(failure)
  })

  it('names a nested cause chain, bounded, without stacks', async () => {
    const { signal } = lifetime()
    const root = new Error('connect ECONNREFUSED')
    const failure = new ToolBatchExecutionError(new Error('store unavailable', { cause: root }))
    const [definition] = dshToolDefinitions(failingWith(failure), signal)
    await expect(definition!.handler({}, {} as never))
      .rejects.toThrow(/^Tool batch execution failed: store unavailable: connect ECONNREFUSED$/)

    const long = new ToolBatchExecutionError(new Error('x'.repeat(5000)))
    const [bounded] = dshToolDefinitions(failingWith(long), signal)
    const error = await bounded!.handler({}, {} as never).then(() => undefined, (error: unknown) => error as Error)
    expect(error?.message.startsWith('Tool batch execution failed: xxx')).toBe(true)
    expect(error!.message.length).toBeLessThanOrEqual(500)
  })

  it('passes an error without a cause through unchanged', async () => {
    const { signal } = lifetime()
    const failure = new Error('aborted')
    const [definition] = dshToolDefinitions(failingWith(failure), signal)
    await expect(definition!.handler({}, {} as never)).rejects.toBe(failure)
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
    expect(prompt).toBe(`Current DSH Mnemon context (quoted plugin data; this snapshot supersedes older Mnemon context). Use memory only when needed and only offered routes. DSH utility tools are available under the mcp__dsh__ prefix. A write requires its final receipt.\n${JSON.stringify({ view: 'route-7 wants a rollback' })}\n\nplan the deploy`)
  })

  it('returns the prompt unchanged when no Mnemon context was offered', () => {
    expect(injectMnemonContext('plan the deploy', [{ content: [{ type: 'text', text: 'nope' }], source: { kind: 'user' } }])).toBe('plan the deploy')
  })
})

/** The `parameters` dsh-superagent's main Session registers for its 21 `orchestrator_*` tools (zod 4.4 `toJSONSchema`, 12 Nov 2026). */
const ORCHESTRATOR_PARAMETERS = JSON.parse(
  readFileSync(new URL('./fixtures/orchestrator-tool-parameters.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

type Handler = (request: unknown, extra: unknown) => Promise<unknown>
type Listed = { tools: { name: string; inputSchema: Record<string, unknown> }[] }
type Called = { content: { type: string; text?: string }[]; isError?: boolean }

/** A batch-executor Agent over the fixture's tools that records each call's arguments as DSH receives them. */
function fixtureAgent(results: (name: string) => { content: unknown[]; isError?: boolean } = name => ({ content: [{ type: 'text', text: `ran ${name}` }] })) {
  const received: { name: string; arguments: unknown }[] = []
  const tools = {
    schemas: () => Object.entries(ORCHESTRATOR_PARAMETERS).map(([name, parameters]) => tool(name, `DSH ${name}`, parameters)),
    execute: async (input: { calls: { id: string; name: string; arguments: string }[] }) => ({
      results: input.calls.map(call => {
        received.push({ name: call.name, arguments: JSON.parse(call.arguments) })
        return { callId: call.id, result: results(call.name) }
      }),
      additionalContexts: [],
      concluded: false,
    }),
  }
  return { agent: { ctx: { tools } } as unknown as Agent, received }
}

/** The in-process MCP server's own request handlers, as Claude Code reaches them. */
function handlersOf(server: ReturnType<typeof createDshToolsMcpServer>) {
  const handlers = (server.instance as unknown as { server: { _requestHandlers: Map<string, Handler> } }).server._requestHandlers
  return {
    list: async () => await handlers.get('tools/list')!({ method: 'tools/list', params: {} }, {}) as Listed,
    call: async (name: string, args: Record<string, unknown>) => {
      try {
        return await handlers.get('tools/call')!(
          { method: 'tools/call', params: { name, arguments: args } },
          { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) },
        ) as Called
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } satisfies Called
      }
    },
  }
}

describe('DSH tools MCP bridge: listing and validation', () => {
  it('lists every orchestrator tool with its DSH parameters verbatim', async () => {
    const { signal } = lifetime()
    const { agent } = fixtureAgent()
    const { tools } = await handlersOf(createDshToolsMcpServer(agent, signal)).list()
    expect(tools.map(({ name }) => name)).toEqual(Object.keys(ORCHESTRATOR_PARAMETERS))
    for (const { name, inputSchema } of tools) expect(inputSchema, name).toEqual(ORCHESTRATOR_PARAMETERS[name])
    const start = tools.find(({ name }) => name === 'orchestrator_workflow_start')!.inputSchema as {
      additionalProperties?: unknown
      properties: Record<string, { description?: string; minLength?: number; pattern?: string }>
    }
    expect(start.additionalProperties).toBe(false)
    expect(start.properties.trigger_id?.description).toMatch(/returns the run it started/)
    expect(start.properties.cwd?.pattern).toBe('^\\/')
  })

  it('refuses an unknown top-level key instead of stripping it before DSH sees the call', async () => {
    const { signal } = lifetime()
    const { agent, received } = fixtureAgent()
    const { call } = handlersOf(createDshToolsMcpServer(agent, signal))
    const refused = await call('orchestrator_workflow_start', { script: 'run.js', cwd: '/srv/work', triggerId: 'trg-1' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('triggerId')
    const status = await call('orchestrator_workflow_status', { runId: 'wf-1' })
    expect(status.isError).toBe(true)
    expect(received).toEqual([])

    const started = await call('orchestrator_workflow_start', { script: 'run.js', cwd: '/srv/work', trigger_id: 'trg-1' })
    expect(started).toEqual({ content: [{ type: 'text', text: 'ran orchestrator_workflow_start' }] })
    expect(received).toEqual([{ name: 'orchestrator_workflow_start', arguments: { script: 'run.js', cwd: '/srv/work', trigger_id: 'trg-1' } }])
  })

  it('runs the turn without DSH tools, and logs it, when the registry cannot project its list', () => {
    const { signal } = lifetime()
    const warnings: string[] = []
    const tools = {
      schemas: () => { throw new Error('tool "plugin_x" parameters must be lossless JSON before schema projection') },
      execute: async () => ({ content: [], isError: false }),
    }
    const agent = { ctx: { tools } } as unknown as Agent
    expect(dshToolDefinitions(agent, signal, message => { warnings.push(message) })).toEqual([])
    expect(createDshToolsMcpServer(agent, signal)).toMatchObject({ type: 'sdk', name: 'dsh' })
    expect(warnings).toEqual([expect.stringContaining('plugin_x')])
  })

  it('refuses a non-text result and says what the model can do instead', async () => {
    const { signal } = lifetime()
    const { agent } = fixtureAgent(() => ({ content: [{ type: 'text', text: 'caption' }, { type: 'image', attachmentId: 'img-1' }] }))
    const { call } = handlersOf(createDshToolsMcpServer(agent, signal))
    const reply = await call('orchestrator_eval_read', { trigger_id: 'trg-1', resource: 'image', image_id: 'img-1' })
    expect(reply.isError).toBe(true)
    expect(reply.content[0]).toEqual({ type: 'text', text: 'caption' })
    expect(reply.content[1]?.text).toMatch(/text results only.*Work from the text/s)
  })
})
