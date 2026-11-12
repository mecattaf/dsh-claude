import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_PRESETS } from '../src/forwarding.ts'
import { Config, claudeRunsSession } from '../src/index.ts'

describe('llm-claude Config', () => {
  it('Config defaults equal upstream behaviour', () => {
    const resolved = Config({})
    // No preset carries DSH's system prompt into Claude Code's.
    expect(resolved.systemPromptPresets).toEqual([])
    // Empty: the shared plugin settings file decides, as it did before the key existed.
    expect(resolved.permissionSelector).toBe('')
    // The bridge admits the prefixes it admitted before the key existed.
    expect(resolved.bridgedTools).toEqual(['mnemon_', 'jev_', 'orchestrator_'])
    expect(Config({ bridgedTools: ['notes_'] }).bridgedTools).toEqual(['notes_'])
    // Unset: a profile that names no limit keeps the shared Settings value or the built-in one.
    expect(resolved.idleTimeoutMs).toBeUndefined()
    expect(resolved.maxProcesses).toBeUndefined()
  })

  it('takes profile supervisor limits and still bounds them', () => {
    expect(Config({ idleTimeoutMs: 60_000, maxProcesses: 2 })).toMatchObject({ idleTimeoutMs: 60_000, maxProcesses: 2 })
    expect(() => Config({ idleTimeoutMs: 999 })).toThrow()
    expect(() => Config({ maxProcesses: 0 })).toThrow()
    expect(() => Config({ maxProcesses: 1.5 })).toThrow()
  })

  it('takes the presets whose DSH system prompt is appended', () => {
    expect(Config({ systemPromptPresets: ['dsh-superagent-router'] }).systemPromptPresets).toEqual(['dsh-superagent-router'])
  })

  it('takes a profile permission selector and refuses an unknown one', () => {
    expect(Config({ permissionSelector: 'native' }).permissionSelector).toBe('native')
    expect(Config({ permissionSelector: 'plugin' }).permissionSelector).toBe('plugin')
    expect(() => Config({ permissionSelector: 'host' as never })).toThrow()
  })
})

describe('claudeRunsSession', () => {
  const claudeModel = { provider: 'claude', model: 'opus' }
  const otherModel = { provider: 'deepseek', model: 'deepseek-chat' }

  it('gives a claude preset Session the plugin UI whatever its model', () => {
    // The preset's route sends every request to Claude Code.
    expect(claudeRunsSession('claude', claudeModel, DEFAULT_CLAUDE_PRESETS)).toBe(true)
    expect(claudeRunsSession('claude', otherModel, DEFAULT_CLAUDE_PRESETS)).toBe(true)
    expect(claudeRunsSession('claude', undefined, DEFAULT_CLAUDE_PRESETS)).toBe(true)
  })

  it('gives a router or worker Session the plugin UI only on a Claude model', () => {
    expect(claudeRunsSession('dsh-superagent-router', claudeModel, DEFAULT_CLAUDE_PRESETS)).toBe(true)
    expect(claudeRunsSession('dsh-superagent-worker', claudeModel, DEFAULT_CLAUDE_PRESETS)).toBe(true)
    // The same Session on another provider keeps the Host's own controls.
    expect(claudeRunsSession('dsh-superagent-router', otherModel, DEFAULT_CLAUDE_PRESETS)).toBe(false)
    expect(claudeRunsSession('dsh-superagent-worker', undefined, DEFAULT_CLAUDE_PRESETS)).toBe(false)
  })

  it('follows the configured presets list and refuses a Session with no preset', () => {
    expect(claudeRunsSession('standard', claudeModel, DEFAULT_CLAUDE_PRESETS)).toBe(false)
    expect(claudeRunsSession(undefined, claudeModel, DEFAULT_CLAUDE_PRESETS)).toBe(false)
    expect(claudeRunsSession('dsh-superagent-router', claudeModel, ['claude'])).toBe(false)
    expect(claudeRunsSession('claude', claudeModel, ['dsh-superagent-router'])).toBe(false)
    expect(claudeRunsSession('standard', claudeModel, ['claude', 'standard'])).toBe(true)
  })
})
