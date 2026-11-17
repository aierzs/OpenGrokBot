import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTurnPrompt } from './agent.js'
import { ownerReplyRequired } from './prompt.js'
import { findMentions } from './mentions.js'
import { Orchestrator, expandSkills, initialQueue } from './orchestrator.js'
import { nextRun, parseCron } from './cron.js'
import { reviewByRules } from './approvals.js'
import { __test as routerTest } from './router.js'
import type { Agent, Conversation, Message, Team } from '../shared/types.js'

function agent(id: string, name: string): Agent {
  return { id, name, role: 'ROLE', color: '#fff', model: 'claude-opus-5', effort: 'low', personality: 'p', tools: [], permissionMode: 'dontAsk', shape: 'blob', mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, provider: 'claude', muted: false, approvals: 'auto' }
}

const khaled = agent('khaled', 'KHALED')
const omar = agent('omar', 'OMAR')
const sara = agent('sara', 'SARA ALI')
const team: Team = { company: 'Co', owner: { id: 'user', name: 'Mahmoud Amr', title: 'CEO' }, workspace: '.', agents: [khaled, omar, sara], mcpServers: {}, providers: { claude: { kind: 'claude', label: 'Claude' } }, settings: { maxMessagesPerRound: 8, maxTurnsPerAgentPerRound: 2, maxTurnsPerReply: 40, groupMode: 'everyone', language: 'auto', notifications: true, autoReview: [] }, skills: { standup: { name: 'Standup', description: '', body: 'List what shipped, what is blocked, what is next.' } } }
const smartTeam: Team = { ...team, settings: { ...team.settings, groupMode: 'smart' } }

function group(memberIds = ['user', 'khaled', 'omar', 'sara']): Conversation {
  return { id: 'group', kind: 'group', name: 'Team', memberIds, messages: [], sessions: {} }
}

test('findMentions is case-insensitive, ordered by appearance, and respects word boundaries', () => {
  const found = findMentions('hey @omar and @Khaled, not @omarx or @sara', team.agents)
  assert.deepEqual(found.map((a) => a.id), ['omar', 'khaled'])
})

test('findMentions matches multi-word names and excludes self', () => {
  const found = findMentions('@SARA ALI can you check? @omar too', team.agents, 'omar')
  assert.deepEqual(found.map((a) => a.id), ['sara'])
})

test('initialQueue: no mentions means everyone in team order (everyone mode)', () => {
  assert.deepEqual(initialQueue(team, group(), 'hello all')?.map((a) => a.id), ['khaled', 'omar', 'sara'])
})

test('initialQueue: smart mode defers to the router unless someone is mentioned', () => {
  assert.equal(initialQueue(smartTeam, group(), 'hello all'), null)
  assert.deepEqual(initialQueue(smartTeam, group(), '@omar go')?.map((a) => a.id), ['omar'])
})

test('router.parse accepts ids or names, caps at three, defaults mode to discuss', () => {
  const r = routerTest.parse('Sure: {"speakers":["OMAR","khaled","sara","nobody","omar"],"mode":"weird"}', team.agents)
  assert.deepEqual(r?.ids, ['omar', 'khaled', 'sara'])
  assert.equal(r?.mode, 'discuss')
  assert.equal(routerTest.parse('no json here', team.agents), null)
})

test('initialQueue: mentions restrict to the mentioned members', () => {
  assert.deepEqual(initialQueue(team, group(), '@omar fix the bug')?.map((a) => a.id), ['omar'])
})

test('initialQueue: a DM always goes to the one member', () => {
  const dm: Conversation = { id: 'dm-omar', kind: 'dm', name: 'OMAR', memberIds: ['user', 'omar'], messages: [], sessions: {} }
  assert.deepEqual(initialQueue(team, dm, '@khaled?')?.map((a) => a.id), ['omar'])
})

test('buildTurnPrompt only includes messages since the agent last spoke when it has a session', () => {
  const c = group()
  c.messages = [
    { id: '1', conversationId: 'group', authorId: 'user', text: 'first', createdAt: 1, status: 'done' },
    { id: '2', conversationId: 'group', authorId: 'omar', text: 'my reply', createdAt: 2, status: 'done' },
    { id: '3', conversationId: 'group', authorId: 'khaled', text: 'later', createdAt: 3, status: 'done' },
  ]
  const withSession = buildTurnPrompt(team, c, omar, true)
  assert.ok(withSession.includes('[KHALED]: later'))
  assert.ok(!withSession.includes('first'))
  const fresh = buildTurnPrompt(team, c, omar, false)
  assert.ok(fresh.includes('[Mahmoud Amr]: first'))
  assert.ok(fresh.includes('[OMAR (you)]: my reply'), 'stateless providers see their own earlier lines marked (you)')
})

test('@everyone mentions every member except the speaker', () => {
  assert.deepEqual(findMentions('@everyone status?', team.agents, 'omar').map((a) => a.id), ['khaled', 'sara'])
})

test('expandSkills replaces /skill tokens and leaves unknown ones', () => {
  assert.equal(expandSkills(team, '/standup please'), '[Skill "Standup": List what shipped, what is blocked, what is next.] please')
  assert.equal(expandSkills(team, 'see /unknown and a/b'), 'see /unknown and a/b')
})

test('cron: parse, next run, and bad input', () => {
  const n = nextRun('0 8 * * *', new Date(2026, 8, 13, 9, 0))
  assert.ok(n && n.getHours() === 8 && n.getDate() === 14)
  const w = nextRun('0 9 * * 0-4', new Date(2026, 8, 11, 12, 0)) // Friday → Sunday 09:00
  assert.ok(w && w.getDay() === 0 && w.getHours() === 9)
  assert.throws(() => parseCron('99 * * * *'))
  assert.throws(() => parseCron('* * *'))
})

test('auto-review: require beats allow, no rule asks', () => {
  const t2: Team = { ...team, settings: { ...team.settings, autoReview: [{ id: '1', action: 'allow', tool: 'Bash' }, { id: '2', action: 'require', tool: 'Bash', match: 'rm -rf' }] } }
  assert.equal(reviewByRules(t2, 'Bash', { command: 'git status' }), 'allow')
  assert.equal(reviewByRules(t2, 'Bash', { command: 'rm -rf dist' }), 'require')
  assert.equal(reviewByRules(t2, 'Write', { file_path: 'x' }), 'ask')
})

test('live queue preserves parallel drafts and follows up with fresh context beyond legacy caps', async () => {
  const c = group(['user', 'khaled', 'omar'])
  const trigger = { id: 'user-1', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled, omar], settings: { ...team.settings, groupMode: 'live', maxMessagesPerRound: 2, maxTurnsPerAgentPerRound: 1 } }
  const store = {
    get: () => c,
    addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) },
    list: () => [c],
    updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find((m) => m.id === mid)!, patch),
  }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false)
  const attempts = new Map<string, number>()
  const internals = orchestrator as unknown as {
    draftTurn: (_id: string, a: Agent, signal: AbortSignal) => Promise<{ text: string }>
    liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void>
  }
  internals.draftTurn = async (_id, a, signal) => {
    const attempt = (attempts.get(a.id) ?? 0) + 1
    attempts.set(a.id, attempt)
    const transcript = c.messages.map(m => m.text)
    if (a.id === 'khaled' && attempt === 1) {
      await new Promise(r => setTimeout(r, 5))
      return { text: 'first' }
    }
    if (a.id === 'omar' && attempt === 1) {
      await new Promise(r => setTimeout(r, 25))
      assert.equal(signal.aborted, false, 'a peer reply must not cancel a useful parallel draft')
      return { text: 'prepared in parallel' }
    }
    if (a.id === 'khaled' && attempt === 2) {
      assert.ok(transcript.includes('prepared in parallel'), 'the next turn reads new peer messages')
      return { text: 'fresh follow-up' }
    }
    return { text: '' }
  }
  await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
  assert.deepEqual(c.messages.slice(1).map(m => m.text), ['first', 'prepared in parallel', 'fresh follow-up'])
  assert.equal(attempts.get('omar'), 2, 'one parallel draft and one follow-up, no discarded regeneration')
})

test('live queue skips a hung member and ignores its late answer', async () => {
  const c = group(['user', 'khaled', 'omar'])
  const trigger = { id: 'user-2', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled, omar], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find((m) => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 20, 20)
  let returnLate: ((draft: { text: string }) => void) | undefined
  const internals = orchestrator as unknown as {
    draftTurn: (_id: string, a: Agent) => Promise<{ text: string }>
    liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void>
  }
  internals.draftTurn = async (_id, a) => {
    if (a.id === 'khaled') return new Promise(resolve => { returnLate = resolve })
    assert.equal(c.messages.length, 1, 'ready member replies before the slow member times out')
    return { text: 'healthy member continues' }
  }
  await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
  assert.equal(c.messages[1]?.text, 'healthy member continues', 'ready reply is published before the slow member timeout notice')
  assert.deepEqual(c.messages.slice(1).filter((m) => m.status === 'done').map((m) => m.text), ['healthy member continues'])
  returnLate?.({ text: 'too late' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(c.messages.length, 3)
  assert.deepEqual(orchestrator.queueSnapshot()[c.id] ?? [], [])
})

test('live speaker can finish after the initial deadline when output has begun', async () => {
  const c = group(['user', 'khaled'])
  const trigger = { id: 'user-3', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find((m) => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 60)
  const internals = orchestrator as unknown as {
    draftTurn: (_id: string, a: Agent, signal: AbortSignal, note?: string, onProgress?: (delta: string) => void) => Promise<{ text: string }>
    liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void>
  }
  internals.draftTurn = async (_id, _a, _signal, _note, onProgress) => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      onProgress?.('chunk ')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(c.messages[1]?.status, 'streaming', 'chunks appear before generation finishes')
      assert.equal(c.messages[1]?.text, 'chunk '.repeat(i + 1))
    }
    return { text: 'chunk '.repeat(5) }
  }
  await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
  assert.equal(c.messages[1]?.text, 'chunk '.repeat(5))
  assert.equal(c.messages[1]?.status, 'done')
})

test('live queue does not repeatedly invite a failed provider in the same round', async () => {
  const c = group(['user', 'khaled', 'omar'])
  const trigger = { id: 'failure-test', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled, omar], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 100)
  let failures = 0
  const internals = orchestrator as unknown as { draftTurn: (_id: string, a: Agent) => Promise<{ text: string; error?: string }>; liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void> }
  internals.draftTurn = async (_id, a) => a.id === 'khaled'
    ? (failures++, { text: '', error: 'provider offline' })
    : { text: c.messages.some(m => m.text === 'healthy reply') ? '' : 'healthy reply' }
  await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
  assert.equal(failures, 1)
  assert.deepEqual(c.messages.slice(1).map(m => m.status), ['error', 'done'])
})

test('stopping a live round releases the floor even when providers ignore abort', async () => {
  const c = group(['user', 'khaled', 'omar'])
  const trigger = { id: 'stop-test', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled, omar], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 10_000)
  const internals = orchestrator as unknown as { draftTurn: () => Promise<{ text: string }>; liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void> }
  internals.draftTurn = () => new Promise(() => {})
  const abort = new AbortController()
  const running = internals.liveSpeakers(c.id, { message: trigger }, abort.signal, new Set())
  setImmediate(() => abort.abort())
  await Promise.race([running, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('stop did not release queue')), 500); timer.unref() })])
  assert.deepEqual(orchestrator.queueSnapshot()[c.id], [])
  assert.equal(c.messages.length, 1)
})

test('new owner messages cancel the old round and late answers cannot overwrite the new reply', async () => {
  const c = group(['user', 'khaled'])
  const liveTeam: Team = { ...team, agents: [khaled], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: Conversation['messages'][number]) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, { update: async () => {} } as never, () => false, 100)
  let finishOld: ((value: { text: string }) => void) | undefined
  const internals = orchestrator as unknown as { draftTurn: () => Promise<{ text: string }> }
  internals.draftTurn = async () => c.messages.at(-1)?.text === 'old question'
    ? new Promise(resolve => { finishOld = resolve })
    : { text: 'reply to new question' }
  orchestrator.post(c.id, 'old question')
  assert.equal(orchestrator.isBusy(c.id), true)
  orchestrator.post(c.id, 'new question')
  for (let i = 0; i < 20 && orchestrator.isBusy(c.id); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(orchestrator.isBusy(c.id), false)
  finishOld?.({ text: 'obsolete reply' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(c.messages.map(m => m.text), ['old question', 'new question', 'reply to new question'])
  assert.deepEqual(orchestrator.queueSnapshot()[c.id], [])
})

test('empty chunks do not keep a silent member on the floor forever', async () => {
  const c = group(['user', 'khaled'])
  const trigger = { id: 'empty-chunks', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, message: typeof trigger) => { c.messages.push(message) }, list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 25, 25)
  const internals = orchestrator as unknown as { draftTurn: (_id: string, a: Agent, signal: AbortSignal, note?: string, onDelta?: (delta: string) => void) => Promise<{ text: string }>; liveSpeakers: (_id: string, job: { message: typeof trigger }, signal: AbortSignal, spoke: Set<string>) => Promise<void> }
  let timer: ReturnType<typeof setInterval> | undefined
  internals.draftTurn = async (_id, _agent, _signal, _note, onDelta) => {
    timer = setInterval(() => { onDelta?.(''); onDelta?.('  ') }, 5)
    return new Promise(() => {})
  }
  try {
    await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
    assert.equal(c.messages[1]?.status, 'error')
    assert.match(c.messages[1]?.text ?? '', /思考超时/)
  } finally { clearInterval(timer) }
})


test('thinking stays off the ready queue; only real text changes it to ready', async () => {
  const c = group(['user', 'khaled', 'omar'])
  const trigger = { id: 'stages', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled, omar], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, m: Message) => c.messages.push(m), list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 1000, 2000)
  const internals = orchestrator as unknown as { draftTurn: (_id: string, a: Agent, signal: AbortSignal, note?: string, delta?: (text: string) => void) => Promise<{ text: string }>; liveSpeakers: (_id: string, job: { message: Message }, signal: AbortSignal, spoke: Set<string>) => Promise<void> }
  let readySlow!: () => void
  let releaseFloor!: () => void
  const attempts = new Set<string>()
  internals.draftTurn = async (_id, a, _signal, _note, delta) => {
    if (attempts.has(a.id)) return { text: '' }
    attempts.add(a.id)
    if (a.id === 'khaled') {
      delta?.('  ')
      await new Promise<void>(resolve => { readySlow = () => { delta?.('slow answer'); resolve() } })
      return { text: 'slow answer' }
    }
    delta?.('fast answer')
    await new Promise<void>(resolve => { releaseFloor = resolve })
    return { text: 'fast answer' }
  }
  const abort = new AbortController()
  const running = internals.liveSpeakers(c.id, { message: trigger }, abort.signal, new Set())
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(orchestrator.queueSnapshot()[c.id], [], 'silent thinking must not reserve a speaking position')
    assert.deepEqual(orchestrator.thinkingSnapshot()[c.id], ['khaled'])
    assert.equal(c.messages[1]?.authorId, 'omar', 'the ready member already has the floor')
    readySlow()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(orchestrator.queueSnapshot()[c.id], ['khaled'])
    assert.deepEqual(orchestrator.thinkingSnapshot()[c.id], [], 'a prepared reply is no longer thinking')
    releaseFloor()
    await running
    assert.deepEqual(c.messages.slice(1).map(m => m.text), ['fast answer', 'slow answer'])
    assert.deepEqual(orchestrator.queueSnapshot()[c.id], [])
    assert.deepEqual(orchestrator.thinkingSnapshot()[c.id], [])
  } finally { abort.abort(); await running }
})

test('thinking may exceed the speech timeout and still reply within its own deadline', async () => {
  const c = group(['user', 'khaled'])
  const trigger = { id: 'slow-thinking', conversationId: c.id, authorId: 'user', text: 'hello', createdAt: 1, status: 'done' as const }
  c.messages.push(trigger)
  const liveTeam: Team = { ...team, agents: [khaled], settings: { ...team.settings, groupMode: 'live' } }
  const store = { get: () => c, addMessage: (_id: string, m: Message) => c.messages.push(m), list: () => [c], updateMessage: (_id: string, mid: string, patch: object) => Object.assign(c.messages.find(m => m.id === mid)!, patch) }
  const orchestrator = new Orchestrator(() => liveTeam, store as never, {} as never, {} as never, {} as never, () => false, 20, 500)
  const internals = orchestrator as unknown as { draftTurn: (_id: string, a: Agent, signal: AbortSignal, note?: string, delta?: (text: string) => void) => Promise<{ text: string }>; liveSpeakers: (_id: string, job: { message: Message }, signal: AbortSignal, spoke: Set<string>) => Promise<void> }
  internals.draftTurn = async (_id, _a, signal, _note, delta) => {
    await new Promise(resolve => setTimeout(resolve, 65))
    assert.equal(signal.aborted, false)
    assert.deepEqual(orchestrator.queueSnapshot()[c.id], [])
    delta?.('thought it through')
    return { text: 'thought it through' }
  }
  await internals.liveSpeakers(c.id, { message: trigger }, new AbortController().signal, new Set())
  assert.equal(c.messages[1]?.status, 'done')
  assert.equal(c.messages[1]?.text, 'thought it through')
})


test('owner mention and reply require an answer only until the addressed member replies', () => {
  const c = group()
  const question: Message = { id: 'question', conversationId: c.id, authorId: 'user', text: '@OMAR 请明确回答', createdAt: 1, status: 'done' }
  c.messages.push(question)
  assert.equal(ownerReplyRequired(c, omar), true)
  assert.equal(ownerReplyRequired(c, khaled), false)
  assert.match(buildTurnPrompt(team, c, omar, false), /boss directly addressed you/)
  c.messages.push({ ...question, id: 'peer', authorId: 'khaled', text: 'a peer reply' })
  assert.equal(ownerReplyRequired(c, omar), true, 'peer messages do not cancel the owner mention')
  c.messages.push({ ...question, id: 'answer', authorId: 'omar', text: 'answer' })
  assert.equal(ownerReplyRequired(c, omar), false, 'answered mentions do not trigger endless forced responses')
  c.messages.push({ ...question, id: 'quoted', text: 'why?', replyTo: { messageId: 'answer', authorId: 'omar', excerpt: 'answer' } })
  assert.equal(ownerReplyRequired(c, omar), true)
})
