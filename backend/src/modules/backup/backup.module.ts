// ─────────────────────────────────────────────────────────────
// 每日自动备份：Windows 保留现有 backup.ps1；Linux 使用 pg_dump/pg_restore
// 与 Node 文件操作。所有进程均以参数数组启动，不经过 shell，不拼接连接串。
// ─────────────────────────────────────────────────────────────
import { Controller, Module, Post, Injectable } from '@nestjs/common'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { appendFile, cp, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { Roles } from '../auth/auth.module'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RUN_HOUR = 7
const RUN_MINUTE = 23
const KEEP_DUMPS = 30
const EXEC_TIMEOUT = 30 * 60_000

let lastRunDate = ''

export interface PostgresConnection {
  host: string
  port: string
  user: string
  database: string
  password: string
  sslMode?: string
}

/** 只把密码放进 PGPASSWORD；返回值供参数数组使用，绝不生成 shell 命令。 */
export function parsePostgresConnection(raw = process.env.DATABASE_URL): PostgresConnection {
  if (!raw) throw new Error('未配置 DATABASE_URL，无法执行数据库备份')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DATABASE_URL 格式无效')
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) {
    throw new Error('DATABASE_URL 必须是包含用户和数据库名的 PostgreSQL 连接地址')
  }
  try {
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      database: decodeURIComponent(url.pathname.slice(1)),
      password: decodeURIComponent(url.password),
      sslMode: url.searchParams.get('sslmode') || undefined,
    }
  } catch {
    throw new Error('DATABASE_URL 包含无效的转义字符')
  }
}

export function pgDumpArguments(connection: PostgresConnection, output: string): string[] {
  return [
    '--host', connection.host,
    '--port', connection.port,
    '--username', connection.user,
    '--dbname', connection.database,
    '--format=custom',
    '--file', output,
  ]
}

interface CommandResult { code: number; stdout: string; stderr: string; error?: Error }
function execute(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolveP) => {
    execFile(command, args, { env, windowsHide: true, timeout: EXEC_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolveP({ code, stdout, stderr, error: error ?? undefined })
    })
  })
}

class BackupFailure extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

@Injectable()
export class BackupService {
  private running = false
  private lastResult: { at: string; ok: boolean; message: string; file?: string } | null = null
  private readonly backupDir = resolve(process.env.BACKUP_DIR || join(process.cwd(), 'backups'))
  private readonly uploadsDir = resolve(process.env.UPLOADS_DIR || join(process.cwd(), 'uploads'))

  onModuleInit() {
    const timer = setInterval(() => this.tick(), 60_000)
    timer.unref()
    console.log(`[backup] 每日备份已调度：${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}，平台 ${process.platform}`)
  }

  private tick() {
    const now = new Date()
    if (now.getHours() !== RUN_HOUR || now.getMinutes() !== RUN_MINUTE) return
    const today = now.toISOString().slice(0, 10)
    if (lastRunDate === today) return
    lastRunDate = today
    void this.run().catch(() => {})
  }

  private redact(message: string, password = ''): string {
    let safe = message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[数据库地址已隐藏]')
    if (password) safe = safe.split(password).join('[密码已隐藏]')
    return safe.replace(/[\r\n]+/g, ' ').slice(0, 500)
  }

  private async record(ok: boolean, message: string, file?: string) {
    this.lastResult = { at: new Date().toISOString(), ok, message, ...(file ? { file } : {}) }
    const line = `[${this.lastResult.at}] ${ok ? '成功' : '失败'}：${message}`
    console.log(`[backup] ${line}`)
    await appendFile(join(this.backupDir, 'backup.log'), `${line}\n`, 'utf8').catch((error) => {
      console.warn(`[backup] 无法写入备份日志：${this.redact(String(error))}`)
    })
  }

  async run(): Promise<{ code: number; ok: boolean }> {
    if (this.running) return { code: -1, ok: false }
    this.running = true
    try {
      await mkdir(this.backupDir, { recursive: true })
      return process.platform === 'win32' ? await this.runWindows() : await this.runPosix()
    } catch (error) {
      const code = error instanceof BackupFailure ? error.code : 1
      await this.record(false, this.redact((error as Error).message || String(error)))
      return { code, ok: false }
    } finally {
      this.running = false
    }
  }

  private async runWindows(): Promise<{ code: number; ok: boolean }> {
    const ps1 = resolve(process.cwd(), '..', 'scripts', 'backup.ps1')
    const result = await execute(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1])
    const ok = result.code === 0
    await this.record(ok, ok ? '备份完成' : `退出码 ${result.code}：${this.redact(result.stderr || result.stdout || String(result.error))}`)
    return { code: result.code, ok }
  }

  private async runPosix(): Promise<{ code: number; ok: boolean }> {
    let connection: PostgresConnection
    try {
      connection = parsePostgresConnection()
    } catch (error) {
      await this.record(false, (error as Error).message)
      return { code: 1, ok: false }
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
    const name = `wsms-${stamp}-${randomUUID().slice(0, 8)}.dump`
    const temporary = join(this.backupDir, `.${name}.${randomUUID()}.tmp`)
    const destination = join(this.backupDir, name)
    const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: connection.password }
    if (connection.sslMode) env.PGSSLMODE = connection.sslMode

    try {
      const dumped = await execute('pg_dump', pgDumpArguments(connection, temporary), env)
      if (dumped.code !== 0) throw new BackupFailure(2, `pg_dump 导出失败：${this.redact(dumped.stderr || String(dumped.error), connection.password)}`)
      const checked = await execute('pg_restore', ['--list', temporary], env)
      if (checked.code !== 0) throw new BackupFailure(3, `备份校验失败：${this.redact(checked.stderr || String(checked.error), connection.password)}`)
      await rename(temporary, destination)
      await this.pruneDumps()
      await cp(this.uploadsDir, join(this.backupDir, 'uploads'), { recursive: true, force: true }).catch((error) => {
        throw new BackupFailure(5, `数据库已备份为 ${name}，但 uploads 复制失败：${this.redact(String(error))}`)
      })
      await this.record(true, `数据库及 uploads 备份完成：${name}`, destination)
      return { code: 0, ok: true }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      const code = error instanceof BackupFailure ? error.code : 1
      await this.record(false, this.redact((error as Error).message || String(error), connection.password))
      return { code, ok: false }
    }
  }

  private async pruneDumps() {
    const entries = await readdir(this.backupDir, { withFileTypes: true })
    const dumps = entries.filter((entry) => entry.isFile() && /^wsms-.*\.dump$/.test(entry.name))
    const withTimes = await Promise.all(dumps.map(async (entry) => ({
      name: entry.name,
      mtime: (await stat(join(this.backupDir, entry.name))).mtimeMs,
    })))
    withTimes.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(withTimes.slice(KEEP_DUMPS).map((entry) => rm(join(this.backupDir, entry.name), { force: true })))
  }

  status() {
    return {
      scheduled: `${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}`,
      running: this.running,
      platform: process.platform,
      backupDir: this.backupDir,
      lastResult: this.lastResult,
    }
  }
}

@Controller('backup')
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  @Post('run-now')
  @Roles('admin')
  async runNow() {
    const r = await this.svc.run()
    return { ...r, ...this.svc.status() }
  }

  @Post('status')
  status() {
    return this.svc.status()
  }
}

@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
