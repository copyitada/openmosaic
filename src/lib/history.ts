import type { ChatMessage, WireMessage } from './types'

export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

/**
 * Rebuilds the provider transcript from the UI transcript. Text parts become
 * message content, tool parts become assistant tool_calls plus their results,
 * so the server can stay completely stateless.
 */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const text = messageText(message)
      if (text) wire.push({ role: 'user', content: text })
      continue
    }

    const text = messageText(message)
    const tools = message.parts.filter(
      (part): part is Extract<typeof part, { type: 'tool' }> => part.type === 'tool',
    )

    if (tools.length === 0) {
      if (text) wire.push({ role: 'assistant', content: text })
      continue
    }

    wire.push({
      role: 'assistant',
      content: text,
      tool_calls: tools.map((tool) => ({
        id: tool.id,
        type: 'function' as const,
        function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) },
      })),
    })

    for (const tool of tools) {
      wire.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: tool.output || '(no output)',
      })
    }
  }

  return wire
}

/** Plain-text rendering of a conversation, used by the copy button. */
export function conversationToMarkdown(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const body = message.parts
        .map((part) => {
          if (part.type === 'text') return part.text
          if (part.type === 'notice') return `> ${part.text}`
          const args = part.args as Record<string, unknown>
          const detail =
            part.name === 'run_command'
              ? `\`$ ${String(args.command ?? '')}\``
              : `\`${String(args.path ?? '')}\``
          return `${toolLabelSafe(part.name)} · ${detail}\n\n\`\`\`\n${part.output}\n\`\`\``
        })
        .join('\n\n')
      return `## ${message.role === 'user' ? 'You' : 'Agent'}\n\n${body}`
    })
    .join('\n\n---\n\n')
}

function toolLabelSafe(name: string): string {
  return name.replace(/_/g, ' ')
}
