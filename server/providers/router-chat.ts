import { buildSystemPrompt, buildTurnPrompt, ownerReplyRequired, stripSkip } from '../prompt.js'
import { emptyUsage, type RunTurnParams, type TurnResult } from './types.js'

/** Resolve an unconfigured model family against the gateway's actual catalog. */
export async function resolveRouterModel(model: string, baseUrl: string, token: string, signal: AbortSignal): Promise<string> {
  if (!model.startsWith('auto:')) return model
  const family = model.slice(5).trim().toLowerCase()
  if (!family) throw new Error('请填写要连接的模型名称。')
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    signal, headers: { 'anthropic-version': '2023-06-01', 'x-api-key': token },
  })
  if (!response.ok) throw new Error(`读取模型列表失败（HTTP ${response.status}），请在成员设置中填写真实模型 ID。`)
  const body: unknown = await response.json()
  const rows = typeof body === 'object' && body !== null && 'data' in body ? (body as { data: unknown }).data : undefined
  if (!Array.isArray(rows)) throw new Error('网关没有返回有效的模型列表，请在成员设置中填写真实模型 ID。')
  const matches = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || typeof row.id !== 'string') continue
    const name = `${row.id} ${typeof row.display_name === 'string' ? row.display_name : ''} ${typeof row.name === 'string' ? row.name : ''}`.toLowerCase()
    if (name.includes(family)) matches.add(row.id)
  }
  if (matches.size === 0) throw new Error(`网关未提供 ${family} 模型，请先接入该模型或在成员设置中填写真实模型 ID。`)
  if (matches.size > 1) throw new Error(`网关提供多个 ${family} 模型，请在成员设置中选择具体模型：${[...matches].join('、')}`)
  return [...matches][0]!
}

/** Chat-only calls to the user's local Claude-compatible gateway need no CLI session. */
export async function runRouterChat(params: RunTurnParams, baseUrl: string, token: string): Promise<TurnResult> {
  const first = await requestRouterChat(params, baseUrl, token)
  const needsReply = ownerReplyRequired(params.conversation, params.agent)
  const kind = first.usage?.responseKind
  if (params.signal.aborted || first.error || (kind !== 'empty' && !(kind === 'skip' && needsReply))) return first
  const retry = await requestRouterChat({ ...params, note: `${params.note ?? ''}\n上次未返回有效正文。请直接给出一条简短的明确回复，不要输出 [skip]，不要只进行内部推理。` }, baseUrl, token, first.usage?.stopReason === 'max_tokens' ? (first.usage?.model.toLowerCase().includes('glm-') ? 32768 : 8192) : undefined)
  if (first.usage && retry.usage) {
    const before = first.usage
    const after = retry.usage
    after.responseAttempts = [before, after].map(u => ({ kind: u.responseKind!, stopReason: u.stopReason, durationMs: u.durationMs }))
    after.reasoningTokens = (after.reasoningTokens ?? 0) + (before.reasoningTokens ?? 0)
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'durationMs', 'numTurns'] as const) after[key] += before[key]
  }
  if (!params.signal.aborted && !retry.error && (retry.usage?.responseKind === 'empty' || (needsReply && retry.usage?.responseKind === 'skip'))) {
    retry.error = retry.usage?.responseKind === 'skip'
      ? '你已点名该成员，但模型重试后仍选择跳过，未给出回复。'
      : `模型重试后仍返回空正文，未当作主动跳过。${retry.usage?.stopReason ? `结束原因：${retry.usage.stopReason}。` : ''}请稍后重试或检查上游连接。`
  }
  return retry
}

async function requestRouterChat(params: RunTurnParams, baseUrl: string, token: string, maxTokens?: number): Promise<TurnResult> {
  const { team, conversation, agent, signal, handlers, notes, note } = params
  const started = Date.now()
  const usage = emptyUsage(agent.model)
  let text = ''
  let complete = false
  let forwarded = ''
  const forward = (delta: string): void => {
    text += delta
    if (!text.trim() || ['[skip]', '[跳过]'].some(marker => marker.startsWith(text.trim()))) return
    handlers.onDelta(text.slice(forwarded.length))
    forwarded = text
  }
  try {
    const model = await resolveRouterModel(agent.model, baseUrl, token, signal)
    usage.model = model
    // The gateway's Anthropic adapter drops reasoning_effort. GLM's native-compatible
    // endpoint preserves the member's effort setting and reasoning/answer token usage.
    const openai = model.toLowerCase().includes('glm-')
    const system = buildSystemPrompt(team, conversation, agent, '', notes ?? '')
    const prompt = buildTurnPrompt(team, conversation, agent, false, note)
    const budget = maxTokens ?? (openai ? 16384 : 2048)
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/${openai ? 'chat/completions' : 'messages'}`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': token },
      body: JSON.stringify(openai
        ? { model, max_tokens: budget, stream: true, stream_options: { include_usage: true }, reasoning_effort: agent.effort === 'medium' ? 'high' : agent.effort,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }
        : { model, max_tokens: budget, stream: true, system, messages: [{ role: 'user', content: prompt }] }),
    })
    const openaiUsage = (value: any): void => {
      if (!value) return
      usage.inputTokens = value.prompt_tokens ?? usage.inputTokens
      usage.outputTokens = value.completion_tokens ?? usage.outputTokens
      usage.cacheReadTokens = value.prompt_tokens_details?.cached_tokens ?? 0
      usage.reasoningTokens = value.completion_tokens_details?.reasoning_tokens ?? 0
    }
    const stopReason = (value: string): string => value === 'length' ? 'max_tokens' : value === 'stop' ? 'end_turn' : value
    if (!response.ok) throw new Error(`模型路由服务返回 HTTP ${response.status}，请检查该模型的上游连接。`)
    const handle = (data: string): void => {
      if (!data.trim()) return
      if (data.trim() === '[DONE]') { complete = true; return }
      const ev = JSON.parse(data)
      if (openai) {
        if (ev.error) throw new Error('模型路由服务返回流式错误。')
        openaiUsage(ev.usage)
        const choice = ev.choices?.[0]
        if (typeof choice?.delta?.content === 'string') forward(choice.delta.content)
        if (choice?.finish_reason) usage.stopReason = stopReason(choice.finish_reason)
        return
      }
      if (ev.type === 'message_stop') complete = true
      if (ev.type === 'error') throw new Error('模型路由服务返回流式错误。')
      if (ev.type === 'message_start' && ev.message?.usage) {
        usage.inputTokens = ev.message.usage.input_tokens ?? 0
        usage.cacheReadTokens = ev.message.usage.cache_read_input_tokens ?? 0
        usage.cacheCreationTokens = ev.message.usage.cache_creation_input_tokens ?? 0
      }
      if (ev.type === 'message_delta') {
        if (ev.usage) usage.outputTokens = ev.usage.output_tokens ?? 0
        if (typeof ev.delta?.stop_reason === 'string') usage.stopReason = ev.delta.stop_reason
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        forward(ev.delta.text)
      }
    }
    if (response.headers.get('content-type')?.includes('application/json')) {
      const body = await response.json()
      text = openai ? (body.choices?.[0]?.message?.content ?? '') : (body.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n')
      if (stripSkip(text)) handlers.onDelta(text)
      if (typeof body.stop_reason === 'string') usage.stopReason = body.stop_reason
      usage.inputTokens = body.usage?.input_tokens ?? 0
      usage.outputTokens = body.usage?.output_tokens ?? 0
      if (openai) {
        openaiUsage(body.usage)
        if (body.choices?.[0]?.finish_reason) usage.stopReason = stopReason(body.choices[0].finish_reason)
      }
    } else {
      if (!response.body) throw new Error('模型路由服务没有返回响应流。')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let data: string[] = []
      const line = (value: string): void => {
        if (!value) { if (data.length) handle(data.join('\n')); data = [] }
        else if (value.startsWith('data:')) data.push(value.slice(5).trimStart())
      }
      try {
        while (!complete) {
          const chunk = await reader.read()
          buffer += decoder.decode(chunk.value, { stream: !chunk.done })
          let end: number
          while ((end = buffer.indexOf('\n')) !== -1) {
            line(buffer.slice(0, end).replace(/\r$/, ''))
            buffer = buffer.slice(end + 1)
            if (complete) break
          }
          if (chunk.done) break
        }
        if (!complete) {
          if (buffer) line(buffer.replace(/\r$/, ''))
          if (data.length) handle(data.join('\n'))
        }
        if (!complete) throw new Error('模型路由连接在发言结束前断开，请重试。')
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    usage.durationMs = Date.now() - started
    usage.responseKind = !text.trim() ? 'empty' : stripSkip(text) ? 'reply' : 'skip'
    console.info(`[gateway] ${agent.id}: ${usage.responseKind}; stop=${usage.stopReason ?? 'unknown'}; ${usage.durationMs}ms`)
    return { text: stripSkip(text), usage, ...(text.trim() && usage.stopReason === 'max_tokens' ? { error: '回复达到输出上限，正文可能不完整，请要求该成员继续。' } : {}) }
  } catch (err) {
    usage.durationMs = Date.now() - started
    return { text, usage, error: signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err) }
  }
}

export function localRouter(params: RunTurnParams): { baseUrl: string; token: string } | null {
  if (!params.agent.inheritClaudeSettings || params.agent.tools.length || params.agent.mcpServers.length) return null
  const baseUrl = params.provider.baseUrl ?? process.env.ANTHROPIC_BASE_URL
  const token = params.provider.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
  if (!baseUrl || !token) return null
  try {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) return null
  } catch { return null }
  return { baseUrl, token }
}
