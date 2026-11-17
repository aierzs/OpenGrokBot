import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRouterModel, runRouterChat } from './providers/router-chat.js'
import type { RunTurnParams } from './providers/types.js'
import type { Agent, Team } from '../shared/types.js'

const agent: Agent = { id: 'gateway', name: 'Gateway', role: 'Chat', color: '#fff', shape: 'round', provider: 'claude', model: 'test-model', effort: 'low', personality: '', tools: [], permissionMode: 'dontAsk', mcpServers: [], inheritClaudeSettings: true, autoApproveTools: false, muted: false, approvals: 'auto' }
const team: Team = { company: 'Test', owner: { id: 'user', name: 'Owner', title: 'Owner' }, workspace: '.', agents: [agent], providers: {}, mcpServers: {}, skills: {}, settings: { groupMode: 'live', maxMessagesPerRound: 6, maxTurnsPerAgentPerRound: 2, maxTurnsPerReply: 2, language: 'auto', notifications: false, autoReview: [] } }
function params(chunks: string[]): RunTurnParams {
  return { team, agent, provider: { kind: 'claude', label: 'Gateway' }, conversation: { id: 'test', name: 'Test', kind: 'group', memberIds: ['user', agent.id], messages: [], sessions: {} }, sessionId: undefined, signal: AbortSignal.timeout(1000), handlers: { onDelta: text => chunks.push(text), onSession: () => {}, onActivity: () => {} } }
}
const event = (value: object): string => `data: ${JSON.stringify(value)}\r\n\r\n`

test('gateway finishes on message_stop even when the connection remains open', async t => {
  let cancelled = false
  const chunks: string[] = []
  const wire = event({ type: 'message_start', message: { usage: { input_tokens: 12 } } })
    + event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '连接正常' } })
    + event({ type: 'message_delta', usage: { output_tokens: 4 } })
    + event({ type: 'message_stop' })
  // Split inside UTF-8 characters and CRLF delimiters, as real network packets can.
  const bytes = new TextEncoder().encode(wire)
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } }))
  const result = await Promise.race([runRouterChat(params(chunks), 'http://localhost', 'test'), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('message_stop did not release the turn')), 500); timer.unref() })])
  assert.equal(result.error, undefined)
  assert.equal(result.text, '连接正常')
  assert.deepEqual(chunks, ['连接正常'])
  assert.equal(result.usage?.inputTokens, 12)
  assert.equal(result.usage?.outputTokens, 4)
  assert.equal(cancelled, true)
})

test('gateway accepts DONE and does not wait for socket closure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }) + 'data: [DONE]\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } }))
  const result = await runRouterChat(params([]), 'http://localhost', 'test')
  assert.equal(result.text, 'OK')
  assert.equal(result.error, undefined)
})

test('gateway reports a truncated stream while preserving partial output', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }), { headers: { 'content-type': 'text/event-stream' } }))
  const result = await runRouterChat(params([]), 'http://localhost', 'test')
  assert.equal(result.text, 'partial')
  assert.match(result.error ?? '', /断开/)
})

test('gateway handles JSON fallback and strips skip messages', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ content: [{ type: 'text', text: '[skip]' }], usage: { input_tokens: 3, output_tokens: 1 } }))
  const result = await runRouterChat(params([]), 'http://localhost', 'test')
  assert.equal(result.text, '')
  assert.equal(result.error, undefined)
  assert.equal(result.usage?.outputTokens, 1)
})

test('gateway reports HTTP failures and aborts instead of silently skipping', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  assert.match((await runRouterChat(params([]), 'http://localhost', 'test')).error ?? '', /503/)
  fetchMock.mock.mockImplementation(async () => { throw new DOMException('Aborted', 'AbortError') })
  const p = params([])
  p.signal = AbortSignal.abort()
  assert.equal((await runRouterChat(p, 'http://localhost', 'test')).error, 'Stopped.')
})

test('model family discovery uses a real gateway ID and records the actual model in usage', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url))
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'local-route/seed-model', display_name: 'Doubao chat' }, { id: 'other' }] })
    assert.equal(JSON.parse(String(init?.body)).model, 'local-route/seed-model')
    return Response.json({ content: [{ type: 'text', text: 'OK' }] })
  })
  const p = params([])
  p.agent = { ...p.agent, model: 'auto:doubao' }
  const result = await runRouterChat(p, 'http://localhost', 'test')
  assert.deepEqual(requests, ['http://localhost/v1/models', 'http://localhost/v1/messages'])
  assert.equal(result.text, 'OK')
  assert.equal(result.usage?.model, 'local-route/seed-model')
})

test('model discovery never substitutes a different model when the requested model is unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'hy3' }] }))
  const p = params([])
  p.agent = { ...p.agent, model: 'auto:doubao' }
  const result = await runRouterChat(p, 'http://localhost', 'test')
  assert.match(result.error ?? '', /doubao/)
  assert.equal(result.text, '')
})

test('ambiguous model discovery asks for a specific ID instead of selecting silently', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'doubao-small' }, { id: 'doubao-large' }] }))
  await assert.rejects(resolveRouterModel('auto:doubao', 'http://localhost', 'test', params([]).signal), /doubao-small.*doubao-large/)
})

test('explicit model IDs bypass discovery entirely', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected catalog lookup') })
  assert.equal(await resolveRouterModel('claude-models,hy3', 'http://localhost', 'test', params([]).signal), 'claude-models,hy3')
})


test('empty output is retried once and never recorded as an explicit skip', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++
    assert.equal(JSON.parse(String(init?.body)).max_tokens, calls === 1 ? 2048 : 8192)
    return Response.json({ content: [], stop_reason: 'max_tokens', usage: { output_tokens: 2048 } })
  })
  const result = await runRouterChat(params([]), 'http://localhost', 'test')
  assert.equal(calls, 2)
  assert.equal(result.usage?.responseKind, 'empty')
  assert.match(result.error ?? '', /空正文.*max_tokens/)
  assert.equal(result.usage?.outputTokens, 4096, 'both attempts are counted')
  assert.deepEqual(result.usage?.responseAttempts?.map(a => a.kind), ['empty', 'empty'])
})

test('owner mentions retry explicit skips and the retry answers without leaking skip tokens', async t => {
  const chunks: string[] = []
  const p = params(chunks)
  p.conversation.messages.push({ id: 'owner-mention', conversationId: 'test', authorId: 'user', status: 'done', createdAt: 1, text: '@Gateway 请回答我的问题' })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.match(body.messages[0].content, /boss directly addressed you/)
    calls++
    const text = calls === 1 ? '[skip]' : '明确回应'
    return new Response(event({ type: 'content_block_delta', delta: { type: 'text_delta', text } }) + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + event({ type: 'message_stop' }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(calls, 2)
  assert.equal(result.text, '明确回应')
  assert.equal(result.error, undefined)
  assert.deepEqual(chunks, ['明确回应'])
  assert.deepEqual(result.usage?.responseAttempts?.map(a => a.kind), ['skip', 'reply'])
})

test('ordinary skips stay silent without retry but repeated skips after a direct question are visible errors', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ content: [{ type: 'text', text: '[skip]' }], stop_reason: 'end_turn' }) })
  const p = params([])
  const optional = await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(calls, 1)
  assert.equal(optional.usage?.responseKind, 'skip')
  assert.equal(optional.error, undefined)
  p.conversation.kind = 'dm'
  p.conversation.messages.push({ id: 'dm-question', conversationId: 'test', authorId: 'user', status: 'done', createdAt: 1, text: '请回答' })
  const required = await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(calls, 3)
  assert.match(required.error ?? '', /点名.*仍选择跳过/)
})

test('stopping during an empty response does not start an automatic retry', async t => {
  const abort = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; abort.abort(); return Response.json({ content: [] }) })
  const p = params([])
  p.signal = abort.signal
  await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(calls, 1)
})


test('GLM preserves effort and reserves space for reasoning and text via the same gateway', async t => {
  const chunks: string[] = []
  const p = params(chunks)
  p.agent = { ...p.agent, model: 'claude-models,glm-5.3', effort: 'low' }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'http://localhost/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, p.agent.model)
    assert.equal(body.reasoning_effort, 'low')
    assert.equal(body.max_tokens, 16384)
    assert.equal(body.stream_options.include_usage, true)
    return new Response(event({ choices: [{ delta: { reasoning_content: 'private reasoning' } }] })
      + event({ choices: [{ delta: { content: '完整正文' } }] })
      + event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } })
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(result.error, undefined)
  assert.equal(result.text, '完整正文')
  assert.deepEqual(chunks, ['完整正文'], 'internal reasoning never appears as chat text')
  assert.equal(result.usage?.reasoningTokens, 30)
  assert.equal(result.usage?.outputTokens, 40)
  assert.equal(result.usage?.stopReason, 'end_turn')
})

test('GLM retry expands an exhausted reasoning budget and preserves JSON usage', async t => {
  const p = params([])
  p.agent = { ...p.agent, model: 'claude-models,glm-5.3' }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++
    assert.equal(JSON.parse(String(init?.body)).max_tokens, calls === 1 ? 16384 : 32768)
    return Response.json({ choices: [{ message: { content: calls === 1 ? '' : '<html>complete</html>' }, finish_reason: calls === 1 ? 'length' : 'stop' }], usage: { completion_tokens: calls === 1 ? 16384 : 5000, completion_tokens_details: { reasoning_tokens: calls === 1 ? 16384 : 3000 } } })
  })
  const result = await runRouterChat(p, 'http://localhost', 'test')
  assert.equal(calls, 2)
  assert.equal(result.error, undefined)
  assert.equal(result.text, '<html>complete</html>')
  assert.equal(result.usage?.outputTokens, 21384)
  assert.equal(result.usage?.reasoningTokens, 19384)
})
