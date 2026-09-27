import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function createDemoApp() {
  const app = express()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demo-site')
  app.use(express.static(root))
  return app
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEMO_PORT || 4175)
  createDemoApp().listen(port, '127.0.0.1', () => console.log(`Demo site: http://127.0.0.1:${port}`))
}
