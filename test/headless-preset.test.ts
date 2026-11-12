import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as headlessPreset from '../src/headless-preset.ts'

interface Registry {
  composedPreset: ReturnType<typeof vi.fn<(ctx: unknown) => string | undefined>>
  select: ReturnType<typeof vi.fn<(agent: Agent, preset: string) => Promise<string>>>
}

const fibers: Fiber[] = []

afterEach(async () => {
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
})

async function host(config?: headlessPreset.Config, composed?: string) {
  const root = new Context()
  const registry: Registry = {
    composedPreset: vi.fn(() => composed),
    select: vi.fn(async (_agent: Agent, preset: string) => preset),
  }
  root.provide('agents', {} as never)
  root.provide('agentPresets', registry as never)
  const fiber = root.plugin(headlessPreset, config)
  fibers.push(fiber)
  await fiber
  const created = (agent: Agent, source = 'startup') => root.serial('agent/created' as never, { agent, source } as never) as Promise<unknown>
  return { registry, fiber, created }
}

function agent(delegationDepth?: number): Agent {
  return {
    id: 'session-1',
    ctx: {},
    session: { header: delegationDepth === undefined ? {} : { delegationDepth } },
  } as unknown as Agent
}

describe('headless-preset', () => {
  it('binds the configured preset to a top-level agent created without one', async () => {
    const { registry, created } = await host({ preset: 'dsh-superagent-worker' })
    let release: (() => void) | undefined
    registry.select.mockImplementation((_agent, preset) => new Promise(resolve => { release = () => resolve(preset) }))
    const target = agent()
    let settled = false
    const creation = created(target).then(() => { settled = true })
    await vi.waitFor(() => expect(registry.select).toHaveBeenCalledWith(target, 'dsh-superagent-worker'))
    // agent/created is serial: the Agent's queued input waits for the binding.
    expect(settled).toBe(false)
    release?.()
    await creation
    expect(registry.select).toHaveBeenCalledOnce()
  })

  it('binds the claude preset when none is configured', async () => {
    const { registry, created } = await host()
    await created(agent())
    expect(registry.select).toHaveBeenCalledWith(expect.anything(), 'claude')
  })

  it('leaves an agent with a composed preset untouched', async () => {
    const { registry, created } = await host({ preset: 'claude' }, 'dsh-superagent-router')
    await created(agent())
    expect(registry.composedPreset).toHaveBeenCalledOnce()
    expect(registry.select).not.toHaveBeenCalled()
  })

  it('ignores child agents', async () => {
    const { registry, created } = await host({ preset: 'claude' })
    await created(agent(1))
    expect(registry.composedPreset).not.toHaveBeenCalled()
    expect(registry.select).not.toHaveBeenCalled()
  })

  it('ignores a resumed agent', async () => {
    // `dsh headless --session-id` resumes through agents.resume, which
    // announces the Agent with source 'resume'.
    const { registry, created } = await host({ preset: 'claude' })
    await created(agent(), 'resume')
    expect(registry.composedPreset).not.toHaveBeenCalled()
    expect(registry.select).not.toHaveBeenCalled()
  })

  it('stops binding once its plugin is disposed', async () => {
    const { registry, fiber, created } = await host({ preset: 'claude' })
    await fiber.dispose()
    await created(agent())
    expect(registry.select).not.toHaveBeenCalled()
  })
})
