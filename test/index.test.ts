import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('llm-claude Config', () => {
  it('Config defaults equal upstream behaviour', () => {
    const resolved = Config({})
    // No preset carries DSH's system prompt into Claude Code's.
    expect(resolved.systemPromptPresets).toEqual([])
    // Empty: the shared plugin settings file decides, as it did before the key existed.
    expect(resolved.permissionSelector).toBe('')
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
