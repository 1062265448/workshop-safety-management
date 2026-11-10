import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const databaseUrl = process.env.TEST_DATABASE_URL
const username = process.env.WSMS_USER
const password = process.env.WSMS_PASS
if (!databaseUrl || !username || !password) {
  throw new Error('需要 TEST_DATABASE_URL、WSMS_USER、WSMS_PASS，且只能指向隔离测试库')
}
const databaseName = new URL(databaseUrl).pathname.split('/').filter(Boolean).at(-1) ?? ''
if (!/(e2e|test)/i.test(databaseName)) throw new Error('TEST_DATABASE_URL 的数据库名必须包含 e2e 或 test')

const port = Number(process.env.WSMS_TEST_PORT || 3101)
const log = createWriteStream(resolve(root, 'backend', 'test-e2e-server.log'), { flags: 'w' })
const server = spawn(process.execPath, ['dist/main.js'], {
  cwd: resolve(root, 'backend'),
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    JWT_SECRET: 'e2e-only-jwt-secret-not-for-production-2026',
    SETTINGS_ENCRYPTION_KEY: 'e2e-only-settings-key-not-for-production-2026',
    DINGTALK_ENABLED: 'false',
    BACKUP_DIR: resolve(root, 'backups', 'e2e'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.pipe(log)
server.stderr.pipe(log)
let serverExit = null
server.once('exit', (code, signal) => { serverExit = { code, signal } })

async function waitReady() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (serverExit) throw new Error(`测试后端提前退出：${JSON.stringify(serverExit)}；日志见 backend/test-e2e-server.log`)
    try {
      await fetch(`http://127.0.0.1:${port}/api/agent/capabilities`)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error('测试后端启动超时；日志见 backend/test-e2e-server.log')
}

function runE2E() {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['e2e-test.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        WSMS_BASE: `http://127.0.0.1:${port}/api`,
        WSMS_ALLOW_E2E: '1',
        WSMS_ENV: 'test',
        WSMS_DATABASE_NAME: databaseName,
        WSMS_USER: username,
        WSMS_PASS: password,
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`E2E 失败，退出码 ${code}`)))
  })
}

try {
  await waitReady()
  await runE2E()
  console.log('隔离 E2E 全部通过，测试后端即将停止。')
} finally {
  if (!serverExit) {
    server.kill()
    await Promise.race([
      new Promise((resolveStop) => server.once('exit', resolveStop)),
      new Promise((resolveStop) => setTimeout(resolveStop, 5_000)),
    ])
  }
  log.end()
}
