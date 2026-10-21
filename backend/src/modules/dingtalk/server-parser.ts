// ─────────────────────────────────────────────────────────────
// 服务端通报解析器（Node 版）
// 移植自前端 app/src/lib/import/parsePptx.ts，解析规则与前端逐行保持一致：
// 任何规则修正必须两端同步修改（前端交互式导入 + 钉钉自动导入共用口径）
// 与浏览器版的差异仅三处：
//   1. 输入从 File 改为 Buffer（JSZip.loadAsync 两者通吃）
//   2. 照片从 File[] 改为直接落盘 UPLOADS_DIR，返回 /uploads/uuid.ext 路径
//   3. 图片尺寸过滤用头部字节解析代替 createImageBitmap（Node 无 canvas）
// v1 仅支持 PPTX（厂督查通报实际格式）；复查核销页解析出后暂不自动闭环
// ─────────────────────────────────────────────────────────────
import JSZip from 'jszip'
import { writeFileSync } from 'fs'
import { extname } from 'path'
import { randomUUID } from 'crypto'
import { UPLOADS_DIR } from '../uploads/uploads.controller'

export interface ServerDraft {
  key: string
  title: string
  description: string
  locationGuess?: string
  categoryGuess?: string
  riskLevel: 'general' | 'critical' | 'immediate'
  foundAtGuess?: string
  photos: string[] // /uploads/uuid.ext
}

export interface ServerSkipped {
  page: number
  reason: string
  preview: string
}

export interface ServerParseResult {
  drafts: ServerDraft[]
  reviewCount: number
  skipped: ServerSkipped[]
}

/** 可作为照片的图片扩展名（emf/wmf 等矢量图无法展示，跳过） */
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
/** 小于该体积的多半是图标/Logo，不作为现场照片 */
const MIN_PHOTO_BYTES = 8 * 1024

/** 从图片头部字节解析自然尺寸（不支持则返回 null，由体积阈值兜底） */
function imageDims(buf: Buffer): { w: number; h: number } | null {
  try {
    // PNG: 8 字节签名 + IHDR，宽高在 16/20 偏移（大端）
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    // GIF: 'GIF8' + 宽高在 6/10 偏移（小端）
    if (buf.length > 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(10) }
    }
    // BMP: 'BM' + 宽高在 18/22 偏移（小端，高可为负）
    if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { w: buf.readUInt32LE(18), h: Math.abs(buf.readInt32LE(22)) }
    }
    // JPEG: 扫描 SOF0~SOF15 标记（不含 DHT/DAC）
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue }
        const marker = buf[off + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) }
        }
        const len = buf.readUInt16BE(off + 2)
        off += 2 + len
      }
    }
    // WEBP: 直接放行（VP8 变体多，交给体积阈值兜底）
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return { w: 9999, h: 9999 }
    }
  } catch {
    /* fallthrough */
  }
  return null
}

/**
 * 提取单页幻灯片的照片：按版面出现顺序落盘到 UPLOADS_DIR，返回可持久化路径。
 * 链路：slide XML 中 <a:blip r:embed="rIdN"> 出现顺序 → slideN.xml.rels 映射 → ppt/media/*
 */
async function slidePhotos(zip: JSZip, slideName: string, slideXml: string): Promise<string[]> {
  const num = slideName.match(/\d+/)![0]
  const relsFile = zip.file(`ppt/slides/_rels/slide${num}.xml.rels`)
  if (!relsFile) return []

  const relsXml = await relsFile.async('string')
  const targetByRid = new Map<string, string>()
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0]
    const id = tag.match(/\bId="([^"]*)"/)?.[1] ?? ''
    const target = tag.match(/\bTarget="([^"]*)"/)?.[1] ?? ''
    if (id && target.includes('/media/')) targetByRid.set(id, target)
  }

  const rids: string[] = []
  for (const m of slideXml.matchAll(/r:embed="(rId\d+)"/g)) {
    if (!rids.includes(m[1])) rids.push(m[1])
  }

  const paths: string[] = []
  for (const rid of rids) {
    const target = targetByRid.get(rid)
    if (!target) continue
    const mediaPath = `ppt/${target.replace(/^\.\.\//, '')}`
    const ext = extname(mediaPath).toLowerCase()
    if (!PHOTO_EXT.has(ext)) continue
    const entry = zip.file(mediaPath)
    if (!entry) continue
    const buf = await entry.async('nodebuffer')
    if (buf.length < MIN_PHOTO_BYTES) continue
    const dims = imageDims(buf)
    if (dims && (dims.w < 100 || dims.h < 100)) continue
    const name = `${randomUUID()}${ext}`
    writeFileSync(`${UPLOADS_DIR}/${name}`, buf)
    paths.push(`/uploads/${name}`)
  }
  return paths
}

/** 多问题页照片分配：按版面顺序均匀切分，避免重复归档 */
function distributePhotos<T>(photos: T[], count: number): T[][] {
  if (count <= 1) return [photos]
  const per = Math.floor(photos.length / count)
  if (per === 0) return [photos, ...Array.from({ length: count - 1 }, () => [] as T[])]
  const out: T[][] = []
  for (let i = 0; i < count; i++) {
    const start = i * per
    out.push(photos.slice(start, i === count - 1 ? photos.length : start + per))
  }
  return out
}

// ── 以下正则由前端 parsePptx.ts 原样搬来，勿单独修改 ──────────
const PROBLEM_RE = /不符合《|存在[^。]{0,40}(风险|隐患|漏洞)|现场纠偏|不认真、不仔细|流于形式|不到位|未排查出/
const REVIEW_RE = /复查厂?安全督查通报/
const WORKSHOP_RE = /检\s*查([^，,：]{2,20}?车间)/
const WORKSHOP_FALLBACK_RE = /分?检\s*查([^，,]{2,15}?)[，,]/
const TIME_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/跨接线|静电|配电|电源箱|电缆|电线|漏电|接地|电气|用电/, '电气设施'],
  [/消防|灭火器|消火栓|动火|火灾|吸烟|烟头/, '消防应急管理'],
  [/吊|行车|卷扬|起重|天车|葫芦/, '起重设备及设施'],
  [/风机|车床|叉车|振动器|机械|转动|皮带|加压泵|液泵|泵体|阀门/, '设备设施'],
  [/酸碱|酸雾|碱液|硫酸罐|盐酸|硝酸|烧碱|气瓶|危化|泄漏|腐蚀|红区/, '危化品及红区管理'],
  [/面屏|安全带|劳保|臂章|工作服|腰包|洗眼器|防尘|口罩|耳塞/, '职业健康及劳动防护'],
  [/防护网|防护罩|栏杆|护栏|盖板|挡板/, '防护设施'],
  [/通道|标识|标志|警示牌|警戒线/, '作业通道及标志标识'],
  [/脚手架|交叉作业|警戒|隔离|堆放|照明|积水|积灰|高处|文明生产|卫生/, '作业环境及文明生产'],
  [/压力容器|压力管道|储罐|锅炉/, '压力容器及管道'],
  [/联锁|闭锁|急停/, '联锁闭锁急停'],
  [/仪表|液位计|压力表|温度计|流量计/, '仪器仪表'],
  [/检修|维修|检维修/, '内部检修'],
  [/外来|承包商|外协|施工人员/, '外来施工'],
  [/培训|教育|持证|取证/, '教育培训管理'],
  [/制度|规程|记录|台账|预案/, '制度规程记录管理'],
  [/车辆|运输|叉车|货车|装载/, '车辆及运输管理'],
]
const SANWEI_RE = /警戒区|未佩戴|未放下|未系挂|徒手|吊臂|纠偏|违章|互保联保|酒后|安全帽|安全带|摘钩|面屏/

function cleanParagraph(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/([一-龥]) (?=[一-龥])/g, '$1')
    .replace(/([0-9]) (?=[:：])/g, '$1')
    .replace(/([:：]) (?=[0-9])/g, '$1')
    .trim()
}

function slideParagraphs(xml: string): string[] {
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&')
  const paras: string[] = []
  for (const pm of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = Array.from(pm[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (m) => unescape(m[1]))
    const text = cleanParagraph(runs.join(''))
    if (text) paras.push(text)
  }
  return paras
}

function pickCaption(paras: string[]): string | undefined {
  const candidates = paras.filter((p) => p.length >= 4 && p.length <= 24 && !p.includes('。'))
  return candidates.find((p) => /未|无|缺|失效|不足|不规范|破损|脱落|断开|松动|开焊/.test(p)) ?? candidates[candidates.length - 1]
}

function stripCaptions(paras: string[]): string[] {
  const out = [...paras]
  while (out.length > 1) {
    const last = out[out.length - 1]
    if (last.length <= 24 && !last.includes('。')) out.pop()
    else break
  }
  return out
}

function extractWorkshop(body: string): string | undefined {
  return body.match(WORKSHOP_RE)?.[1]?.trim() ?? body.match(WORKSHOP_FALLBACK_RE)?.[1]?.trim()
}

function guessCategory(text: string, sanwei: boolean): string | undefined {
  if (sanwei && SANWEI_RE.test(text)) return '生产组织及行为管控'
  return CATEGORY_RULES.find(([re]) => re.test(text))?.[1] ?? (sanwei ? '生产组织及行为管控' : undefined)
}

function guessRisk(text: string): ServerDraft['riskLevel'] {
  if (/重大|红区|火灾|爆炸/.test(text)) return 'critical'
  if (/即知即改|现场纠偏|当场整改|立即整改|现场已|已现场/.test(text)) return 'immediate'
  return 'general'
}

function fileYear(name: string): number {
  return Number(name.match(/(20\d{2})\s*年/)?.[1]) || new Date().getFullYear()
}

function toIso(year: number, m: string, d: string, h: string, min: string): string {
  return new Date(year, Number(m) - 1, Number(d), Number(h), Number(min)).toISOString()
}

function splitMultiProblem(body: string): string[] {
  const marker = body.match(/存在问题[：:]/)
  if (!marker) return [body]
  const head = body.slice(0, marker.index! + marker[0].length)
  const rest = body.slice(marker.index! + marker[0].length)
  const parts = rest.split(/[；;。]\s*(?=\d+[.、])/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return [body]
  return parts.map((p, i) => `${head}${p.replace(/^\d+[.、]\s*/, '')}${i < parts.length - 1 ? '；' : ''}`)
}

/** 解析通报 PPTX（Buffer 输入），照片直接落盘 uploads */
export async function parsePptxServer(buf: Buffer, fileName: string): Promise<ServerParseResult> {
  const zip = await JSZip.loadAsync(buf)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))

  const year = fileYear(fileName)
  const sanwei = /三违/.test(fileName)
  const drafts: ServerDraft[] = []
  const skipped: ServerSkipped[] = []
  let reviewCount = 0

  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string')
    const paras = slideParagraphs(xml)
    const body = paras.join('\n')

    // ── 复查核销页：v1 只计数不自动闭环（自动闭环涉及人工确认，留待后续） ──
    if (REVIEW_RE.test(body)) {
      reviewCount++
      continue
    }

    // ── 问题页 ──
    if (!PROBLEM_RE.test(body)) {
      const page = Number(name.match(/\d+/)![0])
      const hasPhotos = /<a:blip[^>]*r:embed=/.test(xml)
      skipped.push({
        page,
        reason: !body.trim() ? (hasPhotos ? '纯图片页，无文本' : '空白页') : '未含问题或复查句式',
        preview: body.replace(/\n/g, ' ').slice(0, 60),
      })
      continue
    }

    const workshop = extractWorkshop(body)
    const timeMatch = body.match(TIME_RE)
    const foundAtGuess = timeMatch ? toIso(year, timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]) : undefined

    const contentParas = stripCaptions(paras)
    const segments = splitMultiProblem(contentParas.join('\n'))
    const multi = segments.length > 1
    const photosBySegment = distributePhotos(await slidePhotos(zip, name, xml), segments.length)

    segments.forEach((seg, idx) => {
      const caption = multi ? undefined : pickCaption(paras.slice(1))
      const description = multi ? seg : contentParas.join('\n')

      let title = caption
      if (!title) {
        const core = (multi ? seg.replace(/.*?存在问题[：:]/, '') : description)
          .replace(/^\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*\d{1,2}\s*[:：]\s*\d{2}\s*分?/, '')
          .replace(/^检\s*查[^，,]{2,20}?车间[，,]?/, '')
        const firstSentence = core.split('。')[0] ?? core
        title = firstSentence.length > 30 ? `${firstSentence.slice(0, 30)}…` : firstSentence
      }
      if (workshop && !title.includes(workshop)) title = `${workshop} · ${title}`

      drafts.push({
        key: `${fileName}-slide-${name}${multi ? `-${idx}` : ''}`,
        title,
        description,
        locationGuess: workshop,
        categoryGuess: guessCategory(seg, sanwei),
        riskLevel: guessRisk(seg),
        foundAtGuess,
        photos: photosBySegment[idx],
      })
    })
  }

  return { drafts, reviewCount, skipped }
}
