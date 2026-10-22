// ─────────────────────────────────────────────────────────────
// 钉钉通报自动导入：每天 07:40 从「班组安全综治工作联络群」拉取厂督查通报，
// 下载 → 服务端解析（server-parser）→ 自动建档标签 → 库内查重（≥75% 同题跳过）
// → 批量入库（成品车间自动纳入闭环，其他车间仅参考）→ 台账记录（messageId 幂等）
// 设计要点：
//   - 幂等：dingtalk_imports 表按 messageId 唯一约束，同一通报永不重复导入
//   - 健壮：单个文件失败只记台账不中断整批；dws 调用超时兜底
//   - 通知：导入完成后向群里发一条结果汇报（发送失败不影响导入结果）
// 配置走环境变量：DINGTALK_GROUP（群名）、DINGTALK_PRELABEL=1 开启 AI 预标注
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common'
import { execFile } from 'child_process'
import { readFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PrismaService } from '../../prisma.service'
import { IssuesModule, IssuesService } from '../issues/issues.module'
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

const INBOX = join(process.cwd(), 'inbox')
const INBOX_DONE = join(INBOX, 'done')
if (!existsSync(INBOX_DONE)) mkdirSync(INBOX_DONE, { recursive: true })

/** 今天 07:40 是否已跑过（跨零点重置） */
let lastRunDate = ''

/** 执行 dws 命令并解析 JSON 输出（cwd 固定为后端目录，保证下载相对路径落 inbox）
 *  Node 不能直接用 execFile 跑 .cmd（EINVAL），必须经 cmd.exe /c 包装。
 *  引号规则很刁钻：cmd /c 会剥掉整串的首尾引号，首令牌（dws 路径无空格）不能加引号，
 *  否则会被当成带引号的程序名报"不是内部或外部命令"；只有含空格的参数才加引号 */
function runDws(args: string[], timeout = 10 * 60_000): Promise<unknown> {
  const cmdline = `${DWS_CMD} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  return new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/d', '/c', cmdline], { cwd: process.cwd(), windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.PATH};${NODE_DIR}` } }, (err, stdout, stderr) => {
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
    private readonly issues: IssuesService,
    private readonly knowledge: KnowledgeService,
    private readonly prelabel: PrelabelService,
  ) {}

  onModuleInit() {
    const timer = setInterval(() => this.tick(), 60_000)
    timer.unref()
    console.log(`[dingtalk] 通报自动导入已调度：每天 ${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}，群「${GROUP}」`)
  }

  private tick() {
    const now = new Date()
    if (now.getHours() !== RUN_HOUR || now.getMinutes() !== RUN_MINUTE) return
    const today = now.toISOString().slice(0, 10)
    if (lastRunDate === today) return
    lastRunDate = today
    void this.run('定时').catch(() => {})
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
    if (this.running) throw new Error('同步正在执行中，请稍后再试')
    this.running = true
    const summary = { files: 0, imported: 0, issues: 0, dups: 0, message: '' }
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
          // 6. 批量入库（字段口径与前端 confirmImport 一致）
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
          if (items.length) await this.issues.createBatch(items)
          // 7. 台账（按 messageId 幂等：失败记录下次重跑时更新覆盖）+ 归档
          await this.prisma.dingtalkImport.upsert({
            where: { messageId: m.messageId },
            create: {
              messageId: m.messageId,
              fileId: ref.resourceId,
              fileName: ref.name!,
              sizeBytes: dl.sizeBytes,
              issueCount: items.length,
              dupCount: parsed.drafts.length - accepted.length,
            },
            update: {
              fileId: ref.resourceId,
              fileName: ref.name!,
              sizeBytes: dl.sizeBytes,
              issueCount: items.length,
              dupCount: parsed.drafts.length - accepted.length,
              status: 'ok',
              error: null,
            },
          })
          renameSync(local, join(INBOX_DONE, ref.name!))
          summary.imported++
          summary.issues += items.length
        } catch (e) {
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
      this.lastResult = { at: new Date().toISOString(), ok: true, message: `${trigger}：${summary.message}` }
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
    return { scheduled: `${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}`, group: GROUP, prelabel: PRELABEL, running: this.running, lastResult: this.lastResult, records }
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
  imports: [IssuesModule, KnowledgeModule, PrelabelModule],
  controllers: [DingtalkController],
  providers: [DingtalkService, PrismaService],
})
export class DingtalkModule {}
