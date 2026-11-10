// ─────────────────────────────────────────────────────────────
// 钉钉通报自动导入：每天 07:40 从「班组安全综治工作联络群」拉取厂督查通报，
// 下载 → 服务端解析（server-parser）→ 自动建档标签 → 库内查重（≥75% 同题跳过）
// → 独立批次入库（成品车间自动纳入闭环，其他车间仅参考）→ 台账记录 → 文件归档
// 设计要点：
//   - 幂等：ImportBatch 使用 dingtalk:messageId，台账前崩溃重跑也只回放原批次
//   - 健壮：单文件业务失败记台账；台账后的归档失败只告警，不触发业务重跑
//   - 通知：导入完成后向群里发一条结果汇报（发送失败不影响导入结果）
// 配置走环境变量：DINGTALK_GROUP（群名）、DINGTALK_PRELABEL=1 开启 AI 预标注
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Get, Injectable, Module, Post, ServiceUnavailableException } from '@nestjs/common'
import { execFile } from 'child_process'
import { readFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { delimiter, join } from 'path'
import { PrismaService } from '../../prisma.service'
import { ImportsModule, ImportService } from '../imports/imports.module'
import { KnowledgeModule, KnowledgeService, dupMetaVerdict } from '../knowledge/knowledge.module'
import { PrelabelModule, PrelabelService } from '../issues/prelabel.module'
import { Roles } from '../auth/auth.module'
import { parsePptxServer } from './server-parser'

const DWS_CMD = process.env.DWS_CMD || 'E:\\KimiData\\daimon-share\\daimon\\npm-global\\dws.cmd'
/** dws.cmd 是 npm 垫片，依赖 PATH 里有 node.exe：服务进程 PATH 常不含运行时目录，显式补上 */
const NODE_DIR = process.env.DWS_NODE_DIR || 'E:\\programs\\kimi\\resources\\resources\\runtime'
const GROUP = process.env.DINGTALK_GROUP || '班组安全综治工作联络群'
const PRELABEL = process.env.DINGTALK_PRELABEL === '1'
const RUN_HOUR = 7
const RUN_MINUTE = 40
/** 通报文件名特征：含「通报」的 PPTX（排除责任区划分表等参考件） */
const BULLETIN_RE = /通报.*\.pptx$/i
/** 整改期限（天）：与前端 IssueEntry 一致 */
const DEADLINE_DAYS: Record<string, number> = { critical: 3, general: 15, immediate: 0 }

export interface DingtalkAvailability {
  enabled: boolean
  configured: boolean
  available: boolean
  executor: 'windows-cmd' | 'direct' | 'none'
  reason: string
}

/** 非 Windows 只有显式 DINGTALK_EXECUTOR 或 DWS_CMD 才可执行，且不得调用 cmd.exe。 */
export function getDingtalkAvailability(platform = process.platform, env: NodeJS.ProcessEnv = process.env): DingtalkAvailability {
  const enabled = !/^(false|0|off)$/i.test(env.DINGTALK_ENABLED?.trim() || '')
  if (!enabled) return { enabled, configured: false, available: false, executor: 'none', reason: 'DINGTALK_ENABLED=false，钉钉同步已禁用' }
  if (platform === 'win32') return { enabled, configured: true, available: true, executor: 'windows-cmd', reason: '' }
  const direct = (env.DINGTALK_EXECUTOR || env.DWS_CMD || '').trim()
  if (!direct) return { enabled, configured: false, available: false, executor: 'none', reason: '当前非 Windows 平台未配置 DINGTALK_EXECUTOR，钉钉执行器不可用' }
  return { enabled, configured: true, available: true, executor: 'direct', reason: '' }
}

const AVAILABILITY = getDingtalkAvailability()
const DIRECT_EXECUTOR = (process.env.DINGTALK_EXECUTOR || process.env.DWS_CMD || '').trim()
const INBOX = join(process.cwd(), 'inbox')
const INBOX_DONE = join(INBOX, 'done')
if (!existsSync(INBOX_DONE)) mkdirSync(INBOX_DONE, { recursive: true })

let lastRunDate = ''

/** Windows 经 cmd.exe 执行 .cmd；其他平台只用直接参数数组，无 shell 拼接。 */
function runDws(args: string[], timeout = 10 * 60_000): Promise<unknown> {
  if (!AVAILABILITY.available) return Promise.reject(new Error(AVAILABILITY.reason))
  const windows = AVAILABILITY.executor === 'windows-cmd'
  const command = windows ? 'cmd.exe' : DIRECT_EXECUTOR
  const commandArgs = windows
    ? ['/d', '/c', `${DWS_CMD} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`]
    : args
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, {
      cwd: process.cwd(),
      windowsHide: true,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH || ''}${delimiter}${NODE_DIR}` },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`dws ${args[0]} ${args[1] ?? ''} 失败：${(stderr || String(err)).slice(0, 300)}`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`dws 输出非 JSON：${stdout.slice(0, 200)}`))
      }
    })
  })
}

interface MessageInfo {
  messageId: string
  createTime: string
  resourceRefs?: Array<{ contentType: string; name?: string; resourceId: string; resourceIdType: string }>
}

@Injectable()
export class DingtalkService {
  private running = false
  private lastResult: { at: string; ok: boolean; message: string } | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportService,
    private readonly knowledge: KnowledgeService,
    private readonly prelabel: PrelabelService,
  ) {}

  onModuleInit() {
    if (!AVAILABILITY.available) {
      console.warn(`[dingtalk] 定时同步未调度：${AVAILABILITY.reason}`)
      return
    }
    const timer = setInterval(() => this.tick(), 60_000)
    timer.unref()
    console.log(`[dingtalk] 通报自动导入已调度：每天 ${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}，群「${GROUP}」，执行器 ${AVAILABILITY.executor}`)
  }

  private tick() {
    const now = new Date()
    if (now.getHours() !== RUN_HOUR || now.getMinutes() !== RUN_MINUTE) return
    const today = now.toISOString().slice(0, 10)
    if (lastRunDate === today) return
    lastRunDate = today
    if (!AVAILABILITY.available) {
      console.warn(`[dingtalk] 定时同步已跳过：${AVAILABILITY.reason}`)
      return
    }
    void this.run('定时').catch((error) => console.error(`[dingtalk] 定时同步失败：${(error as Error).message}`))
  }

  /** 拉群消息：筛出未导入过的通报文件消息 */
  private async fetchBulletins(): Promise<MessageInfo[]> {
    const res = (await runDws(['chat', '+chat-messages', '--group', GROUP, '--page-size', '100', '--format', 'json'])) as { messages?: MessageInfo[] }
    const msgs = res.messages ?? []
    const seen = new Set(
      (await this.prisma.dingtalkImport.findMany({ where: { status: 'ok' }, select: { messageId: true } })).map((r) => r.messageId),
    )
    return msgs.filter((m) =>
      (m.resourceRefs ?? []).some((r) => r.resourceIdType === 'fileId' && BULLETIN_RE.test(r.name ?? '')) &&
      !seen.has(m.messageId),
    )
  }

  /** 标签幂等建档：名到库中取，没有则建 */
  private async ensureTagId(name: string | undefined, group: 'category' | 'location'): Promise<string | undefined> {
    const n = (name ?? '').trim()
    if (!n) return undefined
    const hit = await this.prisma.tag.findFirst({ where: { name: n, group } })
    if (hit) return hit.id
    const created = await this.prisma.tag.create({ data: { name: n, group } }).catch(() => null)
    return created?.id ?? (await this.prisma.tag.findFirst({ where: { name: n, group } }))?.id
  }

  /** 执行一轮同步；返回各文件导入结果 */
  async run(trigger: string): Promise<{ files: number; imported: number; issues: number; dups: number; message: string }> {
    if (!AVAILABILITY.available) throw new ServiceUnavailableException(AVAILABILITY.reason)
    if (this.running) throw new Error('同步正在执行中，请稍后再试')
    this.running = true
    const summary = { files: 0, imported: 0, issues: 0, dups: 0, message: '' }
    let hasFailures = false
    try {
      const bulletins = await this.fetchBulletins()
      if (!bulletins.length) {
        summary.message = '没有新的通报文件'
        this.lastResult = { at: new Date().toISOString(), ok: true, message: `${trigger}：${summary.message}` }
        return summary
      }
      for (const m of bulletins) {
        const ref = m.resourceRefs!.find((r) => r.resourceIdType === 'fileId' && BULLETIN_RE.test(r.name ?? ''))!
        summary.files++
        try {
          // 1. 下载到 inbox
          const dl = (await runDws([
            'chat', '+messages-resource-download', '--type', 'fileId',
            '--resource-id', ref.resourceId, '--output', './inbox/', '--format', 'json',
          ])) as { localPath: string; sizeBytes: number }
          const local = join(process.cwd(), dl.localPath)
          // 2. 解析
          const parsed = await parsePptxServer(readFileSync(local), ref.name!)
          // 3. 建档标签
          for (const d of parsed.drafts) {
            ;(d as { categoryId?: string }).categoryId = await this.ensureTagId(d.categoryGuess, 'category')
            ;(d as { locationId?: string }).locationId = await this.ensureTagId(d.locationGuess, 'location')
          }
          // 4. 库内查重：≥75% 判定同一问题，跳过（与导入页规则一致）；
          //    元数据严格核对：车间、日期明确不同的不算同一问题，照常入库
          const sim = await this.knowledge.similarBatch(parsed.drafts.map((d) => `${d.title}\n${d.description}`), 1)
          const accepted = parsed.drafts.filter((d, i) => {
            const hit = sim.results[i]?.[0]
            if (!hit || hit.score < 0.75) return true
            return dupMetaVerdict({ locationName: d.locationGuess, foundAt: d.foundAtGuess }, hit) !== 'diff'
          })
          summary.dups += parsed.drafts.length - accepted.length
          // 5. 可选 AI 预标注（批处理化：20 条/块一次往返）
          let ai = accepted.map(() => null as null | { categoryName?: string | null; riskLevel?: string | null; suggestion?: string | null })
          if (PRELABEL && accepted.length) {
            const r = await this.prelabel.prelabel(accepted.map((d) => ({ title: d.title, description: d.description, workshop: d.locationGuess })))
            ai = r.map((x) => (x.error || x.skipped ? null : x))
          }
          // 6. 独立批次入库：messageId 贯穿重试，台账前崩溃也只会回放原批次。
          const items = accepted.map((d, i) => {
            const managed = !!d.locationGuess?.includes('成品')
            const foundAt = d.foundAtGuess ?? new Date().toISOString()
            const a = ai[i]
            return {
              title: d.title.trim() || '未命名隐患',
              description: d.description,
              categoryId: (d as { categoryId?: string }).categoryId,
              locationId: (d as { locationId?: string }).locationId,
              tagIds: [],
              riskLevel: d.riskLevel,
              status: 'pending' as const,
              scope: managed ? ('managed' as const) : ('reference' as const),
              source: 'pptx' as const,
              sourceFile: ref.name,
              reporter: '钉钉自动导入',
              foundAt,
              photos: d.photos,
              recheckIntervalDays: 7,
              rechecks: [],
              reviewed: false,
              deadline: managed
                ? new Date(new Date(foundAt).getTime() + DEADLINE_DAYS[d.riskLevel] * 86_400_000).toISOString()
                : undefined,
              aiCategory: a?.categoryName ?? null,
              aiRiskLevel: a?.riskLevel ?? null,
            }
          })
          const imported = items.length
            ? await this.imports.createBatch({
                items,
                idempotencyKey: `dingtalk:${m.messageId}`,
                externalMessageId: m.messageId,
                source: 'dingtalk',
              })
            : null
          const createdCount = imported?.createdCount ?? 0
          // 7. 台账成功即代表业务导入完成；其后的文件归档失败不得触发业务失败重跑。
          await this.prisma.dingtalkImport.upsert({
            where: { messageId: m.messageId },
            create: {
              messageId: m.messageId,
              fileId: ref.resourceId,
              fileName: ref.name!,
              sizeBytes: dl.sizeBytes,
              issueCount: createdCount,
              dupCount: parsed.drafts.length - accepted.length,
            },
            update: {
              fileId: ref.resourceId,
              fileName: ref.name!,
              sizeBytes: dl.sizeBytes,
              issueCount: createdCount,
              dupCount: parsed.drafts.length - accepted.length,
              status: 'ok',
              error: null,
            },
          })
          try {
            renameSync(local, join(INBOX_DONE, ref.name!))
          } catch (e) {
            hasFailures = true
            const warning = `「${ref.name}」已入库并写入台账，但归档失败：${(e as Error).message.slice(0, 120)}；`
            summary.message += warning
            console.warn(`[dingtalk] ${warning}`)
          }
          summary.imported++
          summary.issues += createdCount
        } catch (e) {
          hasFailures = true
          const err = (e as Error).message
          await this.prisma.dingtalkImport.upsert({
            where: { messageId: m.messageId },
            create: {
              messageId: m.messageId,
              fileId: ref.resourceId,
              fileName: ref.name!,
              status: 'failed',
              error: err.slice(0, 500),
            },
            update: { status: 'failed', error: err.slice(0, 500) },
          }).catch(() => undefined)
          summary.message += `「${ref.name}」失败：${err.slice(0, 120)}；`
        }
      }
      if (!summary.message) {
        summary.message = `新通报 ${summary.files} 个：入库 ${summary.issues} 条，查重跳过 ${summary.dups} 条`
      }
      this.lastResult = { at: new Date().toISOString(), ok: !hasFailures, message: `${trigger}：${summary.message}` }
      console.log(`[dingtalk] ${this.lastResult.message}`)
      // 结果汇报到群（发送失败不影响导入结果）
      void runDws(['chat', '+send-to-group', '--group', GROUP, '--content', `【通报导入】${summary.message}`], 60_000).catch(() => undefined)
      return summary
    } finally {
      this.running = false
    }
  }

  async status() {
    const records = await this.prisma.dingtalkImport.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })
    return {
      scheduled: `${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}`,
      group: GROUP,
      prelabel: PRELABEL,
      ...AVAILABILITY,
      running: this.running,
      lastResult: this.lastResult,
      records,
    }
  }
}

@Controller('dingtalk')
export class DingtalkController {
  constructor(private readonly svc: DingtalkService) {}

  /** 立即同步一轮（管理员） */
  @Post('sync-now')
  @Roles('admin')
  syncNow() {
    return this.svc.run('手动')
  }

  /** 同步状态与最近台账 */
  @Get('status')
  status() {
    return this.svc.status()
  }
}

@Module({
  imports: [ImportsModule, KnowledgeModule, PrelabelModule],
  controllers: [DingtalkController],
  providers: [DingtalkService, PrismaService],
})
export class DingtalkModule {}
