import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as nativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createDshToolsMcpServer } from '../src/dsh-tools-mcp.ts'

/** A plugin's tool arguments, declared with zod as a DSH Source declares its tools. */
const readArguments = z.object({
  resource: z.enum(['triggers', 'tickets']),
  limit: z.number().int().min(1).optional(),
})

/**
 * The parameters that plugin registers: zod 4.4's JSON Schema, copied to plain
 * JSON. `z.toJSONSchema` attaches a non-enumerable `~standard` to its result,
 * and the registry refuses anything that is not lossless JSON when it projects
 * the schemas the bridge lists, so the producer copies before registering.
 */
const parameters = JSON.parse(JSON.stringify(z.toJSONSchema(readArguments))) as Record<string, unknown>

type JsonRpcReply = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

/**
 * An MCP client on the bridge's in-process server: JSON-RPC messages handed to
 * the server's transport, the way the Agent SDK carries them for an `sdk`
 * server, so listing and calling go through the MCP server's own handlers.
 */
async function connect(server: ReturnType<typeof createDshToolsMcpServer>) {
  const replies = new Map<number, (reply: JsonRpcReply) => void>()
  const transport: {
    onmessage?: (message: unknown) => void
    start(): Promise<void>
    close(): Promise<void>
    send(message: Partial<JsonRpcReply>): Promise<void>
  } = {
    start: async () => {},
    close: async () => {},
    send: async message => {
      if (typeof message.id === 'number') replies.get(message.id)?.(message as JsonRpcReply)
    },
  }
  await server.instance.connect(transport as never)
  let next = 0
  const request = (method: string, params: Record<string, unknown>) => new Promise<JsonRpcReply>(resolve => {
    const id = ++next
    replies.set(id, resolve)
    transport.onmessage!({ jsonrpc: '2.0', id, method, params })
  })
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-claude-test', version: '0.0.0' },
  })
  expect(initialized.error).toBeUndefined()
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return request
}

describe('DSH tools MCP server on the host tool runtime', () => {
  /**
   * The whole path a Claude session's `mcp__dsh__*` call takes on a DSH 0.2
   * host: a zod-declared tool in the host's registry, listed over MCP from
   * `schemas()`, called over MCP and run through the native batch executor.
   * Each half has failed live while stubbed tests stayed green: parameters
   * the registry would not project, and a single-call input that the batch
   * executor rejected with `Tool batch execution failed`.
   */
  it('lists a zod-declared tool and runs its call through the host batch executor', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolsService)
    await ctx.plugin(nativeToolExecutor)
    const ran: unknown[] = []
    ctx.tools.register({
      name: 'orchestrator_read',
      description: 'Read one orchestrator resource.',
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: Record<string, unknown>) => {
        ran.push(args)
        return { read: args.resource, limit: args.limit }
      },
    })
    const agent = { ctx } as unknown as Agent
    const request = await connect(createDshToolsMcpServer(agent, new AbortController().signal))

    const listed = await request('tools/list', {})
    expect(listed.error).toBeUndefined()
    const tools = listed.result?.tools as { name: string; inputSchema: Record<string, unknown> }[]
    expect(tools.map(({ name }) => name)).toEqual(['orchestrator_read'])
    // Listed as the registry projects it, constraints included: the SDK's own
    // listing, re-derived from zod, would show `limit` as a plain number
    // without its bounds and refuse no unknown key.
    expect(tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['triggers', 'tickets'] },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['resource'],
      additionalProperties: false,
    })

    const called = await request('tools/call', { name: 'orchestrator_read', arguments: { resource: 'tickets', limit: 2 } })
    expect(called.error).toBeUndefined()
    expect(called.result).toEqual({ content: [{ type: 'text', text: '{"read":"tickets","limit":2}' }] })
    expect(ran).toEqual([{ resource: 'tickets', limit: 2 }])

    const misspelt = await request('tools/call', { name: 'orchestrator_read', arguments: { resource: 'tickets', limt: 2 } })
    expect(JSON.stringify(misspelt)).toContain('limt')
    expect(ran).toHaveLength(1)
  })
})
