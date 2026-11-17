import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import vm from 'node:vm'
import express, { type Express } from 'express'
import { serveWebClient } from './web.js'

// Exercise Express's real static-file handling without opening a network socket.
function request(app: Express, url: string): Promise<{ status: number; headers: ReturnType<ServerResponse['getHeaders']>; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
    const req = new IncomingMessage(socket as never)
    req.url = url
    req.method = 'GET'
    req.headers = { host: 'localhost', accept: '*/*' }
    const res = new ServerResponse(req)
    res.assignSocket(socket as never)
    res.on('error', reject)
    res.on('finish', () => resolve({ status: res.statusCode, headers: res.getHeaders(), raw: Buffer.concat(chunks).toString() }))
    app(req, res)
  })
}

test('web server returns JavaScript for current assets and 404 for stale assets instead of HTML', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-web-'))
  t.after(() => {
    assert(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep))
    rmSync(dir, { recursive: true })
  })
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'index.html'), '<html>current shell</html>')
  writeFileSync(path.join(dir, 'assets', 'current.js'), 'window.loaded = true')
  writeFileSync(path.join(dir, 'sw.js'), '// current worker')
  const app = express()
  serveWebClient(app, dir)
  const current = await request(app, '/assets/current.js')
  assert.equal(current.status, 200)
  assert.match(String(current.headers['content-type']), /javascript/)
  assert.match(String(current.headers['cache-control']), /immutable/)
  assert.match(current.raw, /window.loaded = true/)
  const stale = await request(app, '/assets/old-build.js')
  assert.equal(stale.status, 404)
  assert.doesNotMatch(stale.raw, /current shell/)
  assert.equal(stale.headers['x-content-type-options'], 'nosniff')
  for (const url of ['/', '/chat/example', '/index.html', '/sw.js']) {
    const result = await request(app, url)
    assert.equal(result.status, 200, url)
    assert.equal(result.headers['cache-control'], 'no-store', url)
  }
})

function workerHarness(fetcher: (request: unknown, init?: unknown) => Promise<Response>) {
  const handlers = new Map<string, (event: unknown) => void>()
  const put: string[] = []
  vm.runInNewContext(readFileSync('client/public/sw.js', 'utf8'), {
    self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    location: { origin: 'http://local.test' }, URL, Response, fetch: fetcher,
    caches: {
      match: async (key: unknown) => key === '/' ? new Response('<html>offline shell</html>', { headers: { 'content-type': 'text/html' } }) : undefined,
      open: async () => ({ put: async (key: { url: string }) => { put.push(key.url) } }),
    },
  })
  return {
    put,
    fetch(url: string, mode: string, destination: string): Promise<Response> | undefined {
      let response: Promise<Response> | undefined
      handlers.get('fetch')!({ request: { url, mode, destination, method: 'GET' }, respondWith: (value: Promise<Response>) => { response = value } })
      return response
    },
  }
}

test('offline worker never substitutes HTML for a missing script but can show an offline navigation shell', async () => {
  const worker = workerHarness(async () => { throw Error('offline') })
  const script = await worker.fetch('http://local.test/assets/old.js', 'cors', 'script')!
  assert.equal(script.type, 'error')
  assert.equal(await script.text(), '')
  const navigation = await worker.fetch('http://local.test/', 'navigate', 'document')!
  assert.match(await navigation.text(), /offline shell/)
  assert.equal(worker.fetch('http://local.test/api/state', 'cors', ''), undefined)
})

test('worker bypasses the HTTP cache for HTML and does not cache HTML returned for script URLs', async () => {
  let options: unknown
  const worker = workerHarness(async (_request, init) => { options = init; return new Response('<html>shell</html>', { headers: { 'content-type': 'text/html' } }) })
  await worker.fetch('http://local.test/', 'navigate', 'document')
  assert.equal((options as { cache: string }).cache, 'no-store')
  await worker.fetch('http://local.test/assets/stale.js', 'cors', 'script')
  assert.deepEqual(worker.put, ['http://local.test/'])
})
