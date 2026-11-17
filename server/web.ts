import express, { type Express } from 'express'
import path from 'node:path'

/** Keep HTML fresh and never answer a missing script request with the SPA shell. */
export function serveWebClient(app: Express, clientDir: string): void {
  app.use(express.static(clientDir, {
    index: false,
    setHeaders(res, file) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (file.endsWith('.html') || path.basename(file) === 'sw.js') res.setHeader('Cache-Control', 'no-store')
      else if (file.startsWith(path.join(clientDir, 'assets') + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    },
  }))
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    if (req.path.startsWith('/assets/') || path.extname(req.path)) {
      res.status(404).type('text/plain').send('File not found. Reload the page to use the current version.')
      return
    }
    res.sendFile(path.join(clientDir, 'index.html'))
  })
}
