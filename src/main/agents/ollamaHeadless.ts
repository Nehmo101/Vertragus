/**
 * Ollama headless dispatch via its local HTTP API (no CLI). Streams tokens
 * into the pane and resolves with the full assistant message.
 */
import type { HeadlessOpts } from '@main/providers/types'
import type { HeadlessHandle, HeadlessResult } from '@main/agents/headless'

const C = { reset: '\x1b[0m', grey: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m' }

export function runOllamaChat(
  prompt: string,
  opts: HeadlessOpts,
  onLine: (chunk: string) => void
): HeadlessHandle {
  const model = opts.model?.trim()
  if (!model) throw new Error('Ollama benötigt ein explizit ausgewähltes lokales Modell.')
  const controller = new AbortController()
  let killed = false

  const done = new Promise<HeadlessResult>((resolve) => {
    const acc: HeadlessResult = { result: '', isError: false }
    const messages = [
      ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
      { role: 'user', content: prompt }
    ]

    void (async () => {
      try {
        const res = await fetch('http://localhost:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true }),
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let pending = ''
        for (;;) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split(/\n/)
          buf = parts.pop() ?? ''
          for (const p of parts) {
            const t = p.trim()
            if (!t) continue
            try {
              const obj = JSON.parse(t) as {
                message?: { content?: string }
                done?: boolean
                prompt_eval_count?: number
                eval_count?: number
              }
              const token = obj.message?.content ?? ''
              acc.result += token
              pending += token
              // flush on newline for readable streaming
              if (pending.includes('\n')) {
                const lines = pending.split('\n')
                pending = lines.pop() ?? ''
                for (const l of lines) onLine(`${l}\r\n`)
              }
              if (obj.done) {
                acc.tokensIn = obj.prompt_eval_count
                acc.tokensOut = obj.eval_count
              }
            } catch {
              /* ignore partial */
            }
          }
        }
        if (pending) onLine(`${pending}\r\n`)
        onLine(`${C.green}✓ fertig${C.reset}\r\n`)
      } catch (err) {
        if (killed) onLine(`${C.grey}— gestoppt —${C.reset}\r\n`)
        else {
          onLine(`${C.red}Ollama-Fehler: ${err instanceof Error ? err.message : String(err)}${C.reset}\r\n`)
          acc.isError = true
        }
      }
      resolve(acc)
    })()
  })

  return {
    pid: undefined,
    done,
    kill() {
      killed = true
      controller.abort()
    }
  }
}
