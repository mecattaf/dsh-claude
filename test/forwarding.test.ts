import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_PRESETS, DEFAULT_FORWARDED_SOURCES, isNoticeMessage, isTurnMessage, pendingDeliveries, type ForwardingMessage } from '../src/forwarding.ts'
import { Config } from '../src/index.ts'

const message = (role: string, source: ForwardingMessage['source'], text = 'x'): ForwardingMessage => ({
  role,
  content: [{ type: 'text', text }],
  ...(source === undefined ? {} : { source }),
})
const person = (text: string) => message('user', { kind: 'user' }, text)
const relay = (text: string) => message('user', { kind: 'dsh-superagent', form: 'relay' }, text)
const notice = (text: string) => message('user', { kind: 'dsh-superagent', form: 'notice', summary: text }, text)
const reply = (text: string) => message('assistant', { kind: 'model' }, text)
const texts = (messages: readonly ForwardingMessage[]) => messages.map(item => (item.content[0] as { text: string }).text)

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

describe('turn and notice messages', () => {
  it('classifies by allowed kind and by DSH context form', () => {
    expect(isTurnMessage(person('a'))).toBe(true)
    expect(isTurnMessage(relay('a'))).toBe(true)
    expect(isTurnMessage(notice('a'))).toBe(false)
    expect(isNoticeMessage(notice('a'))).toBe(true)
    expect(isTurnMessage(message('user', { kind: 'agent-instructions', form: 'instructions' }))).toBe(false)
    expect(isTurnMessage(message('user', { kind: 'dsh-superagent', form: 'snapshot' }))).toBe(false)
    expect(isNoticeMessage(message('user', { kind: 'plugin', form: 'notice', summary: 's' }))).toBe(false)
    expect(isTurnMessage(message('user', undefined))).toBe(false)
    expect(isTurnMessage(message('assistant', { kind: 'user' }))).toBe(false)
    expect(isTurnMessage(relay('a'), ['user'])).toBe(false)
  })
})

describe('pending deliveries', () => {
  it('is empty for a person-only conversation', () => {
    expect(pendingDeliveries([person('a'), reply('b'), person('c'), person('d')])).toEqual([])
  })

  it('collects notices after the previous turn message and relays after the last reply', () => {
    const messages = [
      notice('seen-1'), person('previous'), notice('mid-turn'), reply('done'),
      relay('older'), notice('idle'), relay('answered'), notice('after'),
    ]
    expect(texts(pendingDeliveries(messages))).toEqual(['mid-turn', 'older', 'idle', 'after'])
  })

  it('does not repeat a relay that came ahead of the last reply', () => {
    expect(texts(pendingDeliveries([person('previous'), relay('seen'), reply('done'), relay('answered')]))).toEqual([])
  })

  it('collects everything machine-delivered ahead of a first turn', () => {
    expect(texts(pendingDeliveries([notice('n1'), relay('r1'), relay('r2')]))).toEqual(['n1', 'r1'])
  })

  it('collects nothing when no message can be answered', () => {
    expect(pendingDeliveries([notice('only')])).toEqual([])
  })
})
