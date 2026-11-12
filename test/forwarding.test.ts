import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_PRESETS, DEFAULT_FORWARDED_SOURCES, isTurnMessage, type ForwardingMessage } from '../src/forwarding.ts'
import { Config } from '../src/index.ts'

const message = (role: string, source: ForwardingMessage['source'], text = 'x'): ForwardingMessage => ({
  role,
  content: [{ type: 'text', text }],
  ...(source === undefined ? {} : { source }),
})
const person = (text: string) => message('user', { kind: 'user' }, text)
const relay = (text: string) => message('user', { kind: 'dsh-superagent', form: 'relay' }, text)
const notice = (text: string) => message('user', { kind: 'dsh-superagent', form: 'notice', summary: text }, text)

describe('forwarding defaults', () => {
  it('forwards people and the superagent, on its presets and the claude preset', () => {
    expect(DEFAULT_FORWARDED_SOURCES).toEqual(['user', 'dsh-superagent'])
    expect(DEFAULT_CLAUDE_PRESETS).toEqual(['claude', 'dsh-superagent-router', 'dsh-superagent-worker'])
  })

  it('declares both lists in the plugin schema with those defaults', () => {
    const resolved = Config({})
    expect(resolved.presets).toEqual([...DEFAULT_CLAUDE_PRESETS])
    expect(resolved.forwardedSources).toEqual([...DEFAULT_FORWARDED_SOURCES])
    expect(Config({ presets: ['claude'], forwardedSources: ['user'] })).toMatchObject({ presets: ['claude'], forwardedSources: ['user'] })
  })
})

describe('turn messages', () => {
  it('classifies by allowed kind and by DSH context form', () => {
    expect(isTurnMessage(person('a'))).toBe(true)
    expect(isTurnMessage(relay('a'))).toBe(true)
    expect(isTurnMessage(notice('a'))).toBe(false)
    expect(isTurnMessage(message('user', { kind: 'agent-instructions', form: 'instructions' }))).toBe(false)
    expect(isTurnMessage(message('user', { kind: 'dsh-superagent', form: 'snapshot' }))).toBe(false)
    expect(isTurnMessage(message('user', undefined))).toBe(false)
    expect(isTurnMessage(message('assistant', { kind: 'user' }))).toBe(false)
    expect(isTurnMessage(relay('a'), ['user'])).toBe(false)
  })
})
