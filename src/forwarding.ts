import type { ContentBlock } from '@deepseek-ai/dsh-llm'

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

/** The refusal a Session on a preset outside `presets` gets from the provider. */
export function presetRefusal(provider: string, presets: readonly string[]): string {
  const names = presets.length === 1 ? `the ${presets[0]} preset` : `the presets ${presets.join(', ')}`
  return `dsh-claude: provider ${provider} is available only to ${names} (llm-claude.presets)`
}
