const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { JwtService } = require('@nestjs/jwt')

process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters'
process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)

const {
  AuthGuard,
  AuthService,
  isWeakJwtSecret,
  resolveJwtSecret,
} = require('../dist/modules/auth/auth.module.js')
const { UsersService } = require('../dist/modules/users/users.module.js')
const {
  LlmService,
  deriveSettingsEncryptionKey,
  decryptSettingsValue,
} = require('../dist/modules/knowledge/llm.service.js')
const {
  parsePostgresConnection,
  pgDumpArguments,
} = require('../dist/modules/backup/backup.module.js')
const { getDingtalkAvailability } = require('../dist/modules/dingtalk/dingtalk.module.js')

function authHarness() {
  const state = {
    user: {
      id: 'user-1',
      username: 'admin',
      displayName: '管理员',
      role: 'admin',
      passwordHash: bcrypt.hashSync('Oldpass1', 4),
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    versions: new Map(),
  }
  const prisma = {
    user: {
      async findUnique({ where }) {
        if (where.id && state.user?.id !== where.id) return null
        if (where.username && state.user?.username !== where.username) return null
        return state.user ? { ...state.user } : null
      },
      async update({ data }) {
        state.user = { ...state.user, ...data }
        return { ...state.user }
      },
      async delete() {
        state.user = null
        return {}
      },
      async count() { return 1 },
    },
    setting: {
      async findUnique({ where }) {
        const value = state.versions.get(where.key)
        return value === undefined ? null : { key: where.key, value }
      },
      async upsert({ where, create, update }) {
        const value = state.versions.has(where.key) ? update.value : create.value
        state.versions.set(where.key, value)
        return { key: where.key, value }
      },
    },
    async $transaction(run) { return run(prisma) },
  }
  const jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '7d' } })
  const reflector = { getAllAndOverride: () => false }
  return {
    state,
    prisma,
    jwt,
    service: new AuthService(prisma, jwt),
    users: new UsersService(prisma),
    guard: new AuthGuard(jwt, reflector, prisma),
  }
}

function requestContext(request) {
  return {
    getHandler() {},
    getClass() {},
    switchToHttp() { return { getRequest: () => request } },
  }
}

function bearerRequest(token) {
  return { headers: { authorization: `Bearer ${token}` }, method: 'GET' }
}

async function rejectsUnauthorized(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(typeof error.getStatus, 'function')
    assert.equal(error.getStatus(), 401)
    return true
  })
}

test('生产 JWT_SECRET 必须至少 32 字符且不能使用默认值，开发仍有回退', () => {
  assert.equal(isWeakJwtSecret('short'), true)
  assert.equal(isWeakJwtSecret('wsms-dev-secret-change-me'), true)
  assert.equal(isWeakJwtSecret('a'.repeat(32)), false)
  assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'short' }), /至少 32 字符/)
  assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production' }), /JWT_SECRET/)
  assert.equal(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'b'.repeat(32) }), 'b'.repeat(32))
  assert.equal(resolveJwtSecret({ NODE_ENV: 'development' }), 'wsms-dev-secret-change-me')
})

test('生产进程加载认证模块时弱 JWT_SECRET 会直接终止启动', () => {
  const { spawnSync } = require('node:child_process')
  const { resolve } = require('node:path')
  const result = spawnSync(process.execPath, ['-e', "require('./dist/modules/auth/auth.module.js')"], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'short' },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /至少 32 字符/)
})

test('登录令牌带版本，公开端点无需令牌也不访问用户表', async () => {
  const { service, jwt, guard } = authHarness()
  const { token } = await service.login('admin', 'Oldpass1')
  const payload = await jwt.verifyAsync(token)
  assert.equal(payload.sub, 'user-1')
  assert.equal(payload.tv, '0')

  const publicGuard = new AuthGuard(jwt, { getAllAndOverride: () => true }, {
    user: { findUnique: async () => { throw new Error('公开端点不应查询用户') } },
    setting: { findUnique: async () => { throw new Error('公开端点不应查询版本') } },
  })
  assert.equal(await publicGuard.canActivate(requestContext({ headers: {} })), true)
  const legacy = await jwt.signAsync({ sub: 'user-1', username: 'admin', role: 'admin' })
  await rejectsUnauthorized(guard.canActivate(requestContext(bearerRequest(legacy))))
})

test('修改密码提升版本，旧 Bearer 立即失效且旧密码不能登录', async () => {
  const { service, guard } = authHarness()
  const { token } = await service.login('admin', 'Oldpass1')
  assert.equal(await guard.canActivate(requestContext(bearerRequest(token))), true)
  await service.changePassword('user-1', 'Oldpass1', 'Newpass2')
  await rejectsUnauthorized(guard.canActivate(requestContext(bearerRequest(token))))
  await rejectsUnauthorized(service.login('admin', 'Oldpass1'))
  const renewed = await service.login('admin', 'Newpass2')
  assert.equal(await guard.canActivate(requestContext(bearerRequest(renewed.token))), true)
})

test('管理员重置密码、角色变化和直接角色不一致均撤销旧令牌', async () => {
  const reset = authHarness()
  const resetToken = (await reset.service.login('admin', 'Oldpass1')).token
  await reset.users.resetPassword('user-1', 'other-admin', 'Resetpass3')
  await rejectsUnauthorized(reset.guard.canActivate(requestContext(bearerRequest(resetToken))))

  const changed = authHarness()
  const roleToken = (await changed.service.login('admin', 'Oldpass1')).token
  await changed.users.update('user-1', 'other-admin', { role: 'viewer' })
  await rejectsUnauthorized(changed.guard.canActivate(requestContext(bearerRequest(roleToken))))

  const direct = authHarness()
  const directToken = (await direct.service.login('admin', 'Oldpass1')).token
  direct.state.user.role = 'viewer'
  await rejectsUnauthorized(direct.guard.canActivate(requestContext(bearerRequest(directToken))))
})

test('删除或禁用用户后旧令牌及新登录均被拒绝', async () => {
  const removed = authHarness()
  const removedToken = (await removed.service.login('admin', 'Oldpass1')).token
  await removed.users.remove('user-1', 'other-admin')
  await rejectsUnauthorized(removed.guard.canActivate(requestContext(bearerRequest(removedToken))))

  const disabled = authHarness()
  const disabledToken = (await disabled.service.login('admin', 'Oldpass1')).token
  disabled.state.user.enabled = false
  await rejectsUnauthorized(disabled.guard.canActivate(requestContext(bearerRequest(disabledToken))))
  await rejectsUnauthorized(disabled.service.login('admin', 'Oldpass1'))
})

function llmHarness(initial = []) {
  const rows = new Map(initial.map((row) => [row.key, row.value]))
  const writes = []
  const prisma = {
    setting: {
      async findMany() { return Array.from(rows, ([key, value]) => ({ key, value })) },
      async findUnique({ where }) {
        const value = rows.get(where.key)
        return value === undefined ? null : { key: where.key, value }
      },
      async upsert({ where, create, update }) {
        const value = rows.has(where.key) ? update.value : create.value
        rows.set(where.key, value)
        writes.push({ key: where.key, value })
        return { key: where.key, value }
      },
    },
  }
  return { service: new LlmService(prisma), rows, writes }
}

test('LLM API Key 使用 AES-256-GCM 密文保存并可解密，历史明文兼容', async () => {
  const plaintext = 'sk-test-secret-that-must-never-be-written-to-database'
  const { service, rows, writes } = llmHarness()
  await service.saveConfig({ apiKey: plaintext, baseUrl: 'https://llm.test/v1', model: 'test-model' })
  const stored = rows.get('llm_api_key')
  assert.match(stored, /^enc:v1:/)
  assert.equal(stored.includes(plaintext), false)
  assert.equal((await service.getConfig()).apiKey, plaintext)
  assert.equal(decryptSettingsValue(stored, deriveSettingsEncryptionKey()), plaintext)
  assert.equal(writes.some((write) => Object.values(write).includes(plaintext)), false)

  const legacy = llmHarness([{ key: 'llm_api_key', value: 'legacy-plaintext-key' }])
  assert.equal((await legacy.service.getConfig()).apiKey, 'legacy-plaintext-key')
})

test('缺少或短加密密钥时保存新 Key 明确失败，且不写任何配置', async () => {
  const original = process.env.SETTINGS_ENCRYPTION_KEY
  const { service, writes } = llmHarness()
  try {
    delete process.env.SETTINGS_ENCRYPTION_KEY
    await assert.rejects(service.saveConfig({ apiKey: 'new-secret', baseUrl: 'https://should-not-write.test' }), /SETTINGS_ENCRYPTION_KEY/)
    assert.equal(writes.length, 0)
    process.env.SETTINGS_ENCRYPTION_KEY = 'too-short'
    await assert.rejects(service.saveConfig({ apiKey: 'new-secret' }), /至少 32 字节/)
    assert.equal(writes.length, 0)
  } finally {
    process.env.SETTINGS_ENCRYPTION_KEY = original
  }
})

test('hex、base64 和普通 passphrase 均可派生 256 位加密密钥', () => {
  assert.equal(deriveSettingsEncryptionKey('f'.repeat(64)).length, 32)
  assert.equal(deriveSettingsEncryptionKey(Buffer.alloc(32, 7).toString('base64')).length, 32)
  assert.equal(deriveSettingsEncryptionKey('a-long-random-passphrase-with-32-plus-bytes').length, 32)
  assert.equal(deriveSettingsEncryptionKey('abcdefghijklmnopqrstuvwxyzABCDEF').length, 32)
  assert.throws(() => deriveSettingsEncryptionKey('short'), /至少 32 字节/)
})

test('PostgreSQL 连接被解析为安全参数，密码不出现在 pg_dump 参数中', () => {
  const connection = parsePostgresConnection('postgresql://wsms:p%40ss%2Fword@db:5432/workshop_safety?sslmode=require')
  assert.equal(connection.user, 'wsms')
  assert.equal(connection.password, 'p@ss/word')
  assert.equal(connection.database, 'workshop_safety')
  assert.equal(connection.sslMode, 'require')
  const args = pgDumpArguments(connection, '/app/backups/test.dump')
  assert.equal(args.includes(connection.password), false)
  assert.deepEqual(args.slice(0, 8), ['--host', 'db', '--port', '5432', '--username', 'wsms', '--dbname', 'workshop_safety'])
  assert.throws(() => parsePostgresConnection('http://db/not-postgres'), /PostgreSQL/)
})

test('钉钉仅 Windows 默认可用，非 Windows 必须显式执行器且可整体禁用', () => {
  assert.equal(getDingtalkAvailability('win32', {}).available, true)
  const missing = getDingtalkAvailability('linux', {})
  assert.equal(missing.available, false)
  assert.equal(missing.configured, false)
  assert.match(missing.reason, /未配置/)
  const direct = getDingtalkAvailability('linux', { DINGTALK_EXECUTOR: '/usr/local/bin/dws' })
  assert.equal(direct.available, true)
  assert.equal(direct.executor, 'direct')
  const disabled = getDingtalkAvailability('linux', { DINGTALK_ENABLED: 'false', DINGTALK_EXECUTOR: '/usr/local/bin/dws' })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.available, false)
})
