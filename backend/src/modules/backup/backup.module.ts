// ─────────────────────────────────────────────────────────────
// 每日自动备份：后端进程内定时调度（Windows 计划任务注册被本机权限拒绝，
// 改为随系统服务自调度——系统运行时数据库必然可达，备份时机反而更准）
// 每天 07:23 执行 scripts/backup.ps1（pg_dump 校验落盘 + 保留30份 + uploads镜像），
// 另提供 POST /api/backup/run-now 供管理员立即触发
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Module, Post, Injectable } from '@nestjs/common'
import { execFile } from 'child_process'
import { join, resolve } from 'path'
import { Roles } from '../auth/auth.module'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RUN_HOUR = 7
const RUN_MINUTE = 23

/** 今天 07:23 是否已跑过（跨零点重置） */
let lastRunDate = ''

@Injectable()
export class BackupService {
  private running = false
  private lastResult: { at: string; ok: boolean; message: string } | null = null

  onModuleInit() {
    // 每分钟看一次表：到了 07:23 且今天没跑过就执行（进程重启当天若已过点则当天不再补跑）
    const timer = setInterval(() => this.tick(), 60_000)
    timer.unref()
    console.log(`[backup] 每日备份已调度：${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}（进程内定时）`)
  }

  private tick() {
    const now = new Date()
    if (now.getHours() !== RUN_HOUR || now.getMinutes() !== RUN_MINUTE) return
    const today = now.toISOString().slice(0, 10)
    if (lastRunDate === today) return
    lastRunDate = today
    void this.run().catch(() => {})
  }

  /** 执行备份脚本；返回脚本退出码（0 成功） */
  run(): Promise<{ code: number; ok: boolean }> {
    if (this.running) return Promise.resolve({ code: -1, ok: false })
    this.running = true
    const ps1 = resolve(process.cwd(), '..', 'scripts', 'backup.ps1')
    return new Promise((resolveP) => {
      execFile(
        POWERSHELL,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        { windowsHide: true, timeout: 30 * 60_000 },
        (err, stdout, stderr) => {
          this.running = false
          const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
          const ok = code === 0
          this.lastResult = {
            at: new Date().toISOString(),
            ok,
            message: ok ? '备份完成' : `退出码 ${code}：${(stderr || stdout || String(err)).slice(0, 300)}`,
          }
          console.log(`[backup] ${this.lastResult.message}`)
          resolveP({ code, ok })
        },
      )
    })
  }

  status() {
    return { scheduled: `${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}`, running: this.running, lastResult: this.lastResult }
  }
}

@Controller('backup')
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  /** 立即执行一次备份（管理员；执行需数秒，前端转圈等待即可） */
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
