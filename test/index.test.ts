import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('llm-claude Config', () => {
  it('Config defaults equal upstream behaviour', () => {
    const resolved = Config({})
    // No preset carries DSH's system prompt into Claude Code's.
    expect(resolved.systemPromptPresets).toEqual([])
    // Empty: the shared plugin settings file decides, as it did before the key existed.
    expect(resolved.permissionSelector).toBe('')
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
