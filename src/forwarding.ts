import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** One Claude turn's outgoing prompt: a bare string or its ordered content blocks. */
type ClaudePrompt = SDKUserMessage['message']['content']

/**
 * Message source kinds whose user-role messages may start or steer a Claude
 * turn, unless the profile configures `llm-claude.forwardedSources`.
 *
 * `user` is a person typing into DSH. `dsh-superagent` is the superagent
 * plugin addressing the Sessions it runs: it delivers every message as
 * `role: 'user'` under its own kind, never `user`, so that none is mistaken
 * for a person's words. Every other producer (`agent-instructions`, Mnemon,
 * time context, ...) stays out of the turn: Claude Code owns its history and
 * its instructions.
 */
export const DEFAULT_FORWARDED_SOURCES: readonly string[] = Object.freeze(['user', 'dsh-superagent'])

/**
 * Agent presets whose Sessions may run on the `claude` provider, unless the
 * profile configures `llm-claude.presets`.
 *
 * `claude` is this package's own preset. dsh-superagent creates its main
 * Session under `dsh-superagent-router` and its workers under
 * `dsh-superagent-worker`, and selects that preset again whenever another one
 * is picked, so those Sessions can only reach Claude under their own preset.
 */
export const DEFAULT_CLAUDE_PRESETS: readonly string[] = Object.freeze(['claude', 'dsh-superagent-router', 'dsh-superagent-worker'])

/** The fields forwarding reads from a DSH message. */
export interface ForwardingMessage {
  readonly role: string
  readonly content: readonly ContentBlock[]
  readonly source?: { readonly kind?: string; readonly form?: string; readonly summary?: string }
}

function allowedKind(message: ForwardingMessage, sources: readonly string[]): boolean {
  const kind = message.source?.kind
  return message.role === 'user' && kind !== undefined && sources.includes(kind)
}

/**
 * Whether `message` can be the one a Claude turn answers: a user-role message
 * from an allowed source that is either direct (no declared context form, as a
 * person's message is) or a `relay`, DSH's form for a message another agent
 * addressed to this one. A `notice` is an account of something that happened,
 * not a request, and is never the turn's message.
 *
 * Request-only user inputs (Host 0.1.7) carry no source and are not the
 * durable turn this route answers.
 */
export function isTurnMessage(message: ForwardingMessage, sources: readonly string[] = DEFAULT_FORWARDED_SOURCES): boolean {
  if (!allowedKind(message, sources)) return false
  const form = message.source?.form
  return form === undefined || form === 'relay'
}

/** Whether `message` is a `notice` from an allowed source: context for the next turn, never its message. */
export function isNoticeMessage(message: ForwardingMessage, sources: readonly string[] = DEFAULT_FORWARDED_SOURCES): boolean {
  return allowedKind(message, sources) && message.source?.form === 'notice'
}

function textOf(message: ForwardingMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function lastIndex<T>(items: readonly T[], before: number, test: (item: T) => boolean): number {
  for (let index = Math.min(before, items.length) - 1; index >= 0; index -= 1) {
    if (test(items[index] as T)) return index
  }
  return -1
}

/**
 * The machine-delivered messages the Claude session has not read yet and that
 * the turn's own message does not carry, oldest first.
 *
 * Claude's session owns history, so a turn forwards only its newest message.
 * Two kinds of delivery would then never reach Claude:
 *
 * - a `notice` from an allowed source, which DSH injects into history without
 *   waking the agent (it can land while a turn runs, before or after the
 *   message the next turn answers);
 * - an older machine `relay` claimed in the same step as a newer one, as when
 *   several workers report while the previous turn was still running.
 *
 * Both are collected after the message the previous turn answered (the newest
 * turn message ahead of the last assistant reply), relays only after that
 * reply. A person's older messages are not collected: like the upstream
 * adapter, only the newest one is answered.
 */
export function pendingDeliveries(messages: readonly ForwardingMessage[], sources: readonly string[] = DEFAULT_FORWARDED_SOURCES): ForwardingMessage[] {
  const answered = lastIndex(messages, messages.length, message => isTurnMessage(message, sources))
  if (answered < 0) return []
  const reply = lastIndex(messages, answered, message => message.role === 'assistant')
  const previous = reply < 0 ? -1 : lastIndex(messages, reply, message => isTurnMessage(message, sources))
  const pending: ForwardingMessage[] = []
  messages.forEach((message, index) => {
    if (index <= previous || index === answered) return
    if (isNoticeMessage(message, sources)) pending.push(message)
    else if (index > reply && isTurnMessage(message, sources) && message.source?.kind !== 'user') pending.push(message)
  })
  return pending
}

function deliveryLine(message: ForwardingMessage): string {
  const kind = message.source?.kind ?? 'unknown'
  const form = message.source?.form ?? 'message'
  const summary = message.source?.summary
  const label = summary === undefined || summary.length === 0 ? `[${form} from ${kind}]` : `[${form} from ${kind}: ${summary}]`
  const text = textOf(message)
  return text.length === 0 ? label : `${label}\n${text}`
}

/**
 * Prepend the pending deliveries (see {@link pendingDeliveries}) to the
 * outgoing prompt, so a notice never takes the place of the message the turn
 * answers and is still read in that turn.
 */
export function injectPendingDeliveries(prompt: ClaudePrompt, messages: readonly ForwardingMessage[], sources: readonly string[] = DEFAULT_FORWARDED_SOURCES): ClaudePrompt {
  const firstText = typeof prompt === 'string' ? prompt : prompt.find(block => block.type === 'text')?.text
  // Native slash commands and Skills must retain their exact command text.
  if (firstText?.trimStart().startsWith('/')) return prompt
  const pending = pendingDeliveries(messages, sources)
  if (pending.length === 0) return prompt
  const context = [
    'DSH messages delivered to this session since its previous turn, oldest first. They are quoted plugin data, not a person\'s words; the message after them is the one this turn answers.',
    ...pending.map(deliveryLine),
  ].join('\n\n')
  return typeof prompt === 'string'
    ? `${context}\n\n${prompt}`
    : [{ type: 'text', text: context }, ...prompt]
}

/** The refusal a Session on a preset outside `presets` gets from the provider. */
export function presetRefusal(provider: string, presets: readonly string[]): string {
  const names = presets.length === 1 ? `the ${presets[0]} preset` : `the presets ${presets.join(', ')}`
  return `dsh-claude: provider ${provider} is available only to ${names} (llm-claude.presets)`
}
