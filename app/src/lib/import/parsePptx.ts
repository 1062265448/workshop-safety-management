import JSZip from 'jszip'
import type { IssueDraft, ReviewDraft, RiskLevel } from '@/types'

// ─────────────────────────────────────────────────────────────
// PPTX 解析器：镍冶炼厂安全督查通报 / 三违通报格式
// 通报规律：每页一条隐患（偶有一页多条，"存在问题：1.…；2.…"），句式为
//   「<时间> 分检查<车间>，<问题描述>。不符合《标准》之规定。…消除隐患。」
// 页末常有图片说明短句（如「法兰未加装跨接线」），是现成的标题候选
// 落实类记录页（无问题）、封面、页脚自动跳过
// 复查页（"复查厂安全督查通报…经查，车间整改核销属实"）解析为核销记录
// ─────────────────────────────────────────────────────────────

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** 可作为照片的图片扩展名（emf/wmf 等矢量图浏览器无法展示，跳过） */
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
/** 小于该体积的多半是图标/Logo，不作为现场照片 */
const MIN_PHOTO_BYTES = 8 * 1024

/** 读取图片自然尺寸（加载失败返回 null） */
function imageDims(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/**
 * 提取单页幻灯片的照片，按版面出现顺序返回。
 * 链路：slide XML 中 <a:blip r:embed="rIdN"> 的出现顺序 → slideN.xml.rels 映射 → ppt/media/*
 */
async function slidePhotos(zip: JSZip, slideName: string, slideXml: string): Promise<File[]> {
  const num = slideName.match(/\d+/)![0]
  const relsName = `ppt/slides/_rels/slide${num}.xml.rels`
  const relsFile = zip.file(relsName)
  if (!relsFile) return []

  const relsXml = await relsFile.async('string')
  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml')
  const targetByRid = new Map<string, string>()
  for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id') ?? ''
    const target = rel.getAttribute('Target') ?? ''
    if (id && target.includes('/media/')) targetByRid.set(id, target)
  }

  // 按版面出现顺序取 embed rId（去重）
  const rids: string[] = []
  for (const m of slideXml.matchAll(/r:embed="(rId\d+)"/g)) {
    if (!rids.includes(m[1])) rids.push(m[1])
  }

  const photos: File[] = []
  for (const rid of rids) {
    const target = targetByRid.get(rid)
    if (!target) continue
    const mediaPath = `ppt/${target.replace(/^\.\.\//, '')}`
    const ext = mediaPath.slice(mediaPath.lastIndexOf('.')).toLowerCase()
    if (!PHOTO_EXT.has(ext)) continue
    const entry = zip.file(mediaPath)
    if (!entry) continue
    const blob = await entry.async('blob')
    if (blob.size < MIN_PHOTO_BYTES) continue
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`
    const file = new File([blob], `slide${num}-${rid}${ext}`, { type: mime })
    const dims = await imageDims(file)
    // 过滤小图标：两个方向都要 ≥ 100px
    if (!dims || dims.w < 100 || dims.h < 100) continue
    photos.push(file)
  }
  return photos
}

/** 多问题页的照片分配：按版面顺序均匀切分给各问题（2 问题 4 图 → 各 2 张），避免重复归档 */
function distributePhotos<T>(photos: T[], count: number): T[][] {
  if (count <= 1) return [photos]
  const per = Math.floor(photos.length / count)
  if (per === 0) {
    // 照片比问题少：全部挂到第一条，避免重复
    return [photos, ...Array.from({ length: count - 1 }, () => [] as T[])]
  }
  const out: T[][] = []
  for (let i = 0; i < count; i++) {
    const start = i * per
    const end = i === count - 1 ? photos.length : start + per
    out.push(photos.slice(start, end))
  }
  return out
}

/** 问题页判定：含"不符合《标准》"或"存在…风险/隐患/漏洞"句式，或三违通报的"现场纠偏"；
 *  另含管理批评措辞页（无标准引述但点名问题，如"未对…查验""排查流于形式"） */
const PROBLEM_RE = /不符合《|存在[^。]{0,40}(风险|隐患|漏洞)|现场纠偏|不认真、不仔细|流于形式|不到位|未排查出/
/** 复查页判定（优先于问题页判定） */
const REVIEW_RE = /复查厂?安全督查通报/
/** 车间提取：优先抓到"车间"结尾（避免把车间后的产线区域吞进来） */
const WORKSHOP_RE = /检\s*查([^，,：]{2,20}?车间)/
const WORKSHOP_FALLBACK_RE = /分?检\s*查([^，,]{2,15}?)[，,]/
const TIME_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/
/** 复查页：被复查期号与原问题引述 */
const REVIEW_ISSUE_NO_RE = /(20\d{2})\s*年\s*第\s*(\d+)\s*期/
const REVIEW_QUOTE_RE = /[“"]([^”"]+?)(?:…|\.\.\.)?[”"]/
const REVIEW_CONCLUSION_RE = /经查[，,]([^。]+。?)/

/** 类型关键词 → 内置标签名 */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/跨接线|静电|配电|电源箱|电缆|电线|漏电|接地|电气|用电/, '电气安全'],
  [/消防|灭火器|消火栓|动火|火灾|吸烟|烟头/, '消防安全'],
  [/风机|车床|吊|叉车|振动器|机械|转动|卷扬|行车|皮带|加压泵|液泵/, '机械设备'],
  [/酸碱|酸雾|碱液|硫酸罐|盐酸|硝酸|烧碱|气瓶|危化|泄漏|腐蚀/, '危化品'],
  [/面屏|安全带|劳保|防护网|防护罩|臂章|工作服|腰包|洗眼器/, '防护用具'],
  [/脚手架|交叉作业|警戒|隔离|通道|堆放|照明|积水|高处|栏杆/, '作业环境'],
]

/** 三违（违章行为）关键词：文件名含"三违"时优先适用 */
const SANWEI_RE = /警戒区|未佩戴|未放下|未系挂|徒手|吊臂|纠偏|违章|互保联保|酒后|安全帽|安全带|摘钩|面屏/

/** 高风险作业关键词 → 较大风险 */
const MAJOR_RE = /红区|高处|吊装|动火|受限空间|临时用电|交叉作业|未加装|未采取|失效|断裂|触电|防爆|灼烫|迸溅/

function cleanParagraph(s: string): string {
  return s
    .replace(/\s+/g, ' ') // 折叠空白
    .replace(/([一-龥]) (?=[一-龥])/g, '$1') // 中文之间的空格
    .replace(/([0-9]) (?=[:：])/g, '$1')
    .replace(/([:：]) (?=[0-9])/g, '$1')
    .trim()
}

/** 从单页 XML 提取段落文本（同一段落内的 run 直接拼接，段落间换行） */
function slideParagraphs(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const paras = Array.from(doc.getElementsByTagNameNS(A_NS, 'p'))
  return paras
    .map((p) => {
      const runs = Array.from(p.getElementsByTagNameNS(A_NS, 't'))
      return cleanParagraph(runs.map((r) => r.textContent ?? '').join(''))
    })
    .filter(Boolean)
}

/** 标题候选：页末图片说明短句（短、无句号、含否定词更像问题描述） */
function pickCaption(paras: string[]): string | undefined {
  const candidates = paras.filter((p) => p.length >= 4 && p.length <= 24 && !p.includes('。'))
  return candidates.find((p) => /未|无|缺|失效|不足|不规范|破损|脱落|断开|松动|开焊/.test(p)) ?? candidates[candidates.length - 1]
}

/** 剔除页末图片说明：从尾部向前去掉"短且无句号"的段落（多问题页尤其需要，避免 caption 混入末段正文） */
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
  if (sanwei && SANWEI_RE.test(text)) return '违章作业'
  return CATEGORY_RULES.find(([re]) => re.test(text))?.[1] ?? (sanwei ? '违章作业' : undefined)
}

function guessRisk(text: string): RiskLevel {
  if (/重大|红区|火灾|爆炸/.test(text)) return 'critical'
  if (MAJOR_RE.test(text)) return 'major'
  return 'general'
}

/** 文件名中的年份（如 2026年第525期），缺省用当前年 */
function fileYear(name: string): number {
  return Number(name.match(/(20\d{2})\s*年/)?.[1]) || new Date().getFullYear()
}

function toIso(year: number, m: string, d: string, h: string, min: string): string {
  return new Date(year, Number(m) - 1, Number(d), Number(h), Number(min)).toISOString()
}

/** 一页多问题拆分：「存在问题：1.…；2.…」→ 各问题段 */
function splitMultiProblem(body: string): string[] {
  const marker = body.match(/存在问题[：:]/)
  if (!marker) return [body]
  const head = body.slice(0, marker.index! + marker[0].length)
  const rest = body.slice(marker.index! + marker[0].length)
  // 按 "；2." "。2." 等编号边界切分
  const parts = rest.split(/[；;。]\s*(?=\d+[.、])/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return [body]
  return parts.map((p, i) => `${head}${p.replace(/^\d+[.、]\s*/, '')}${i < parts.length - 1 ? '；' : ''}`)
}

export interface SkippedPage {
  /** 幻灯片页码（从 1 开始） */
  page: number
  /** 跳过原因 */
  reason: string
  /** 页面文本预览（前 60 字），便于人工判断是否有漏识别 */
  preview: string
}

export interface PptxParseResult {
  drafts: IssueDraft[]
  reviews: ReviewDraft[]
  skipped: SkippedPage[]
}

export async function parsePptx(file: File): Promise<PptxParseResult> {
  const zip = await JSZip.loadAsync(file)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))

  const year = fileYear(file.name)
  const sanwei = /三违/.test(file.name)
  const drafts: IssueDraft[] = []
  const reviews: ReviewDraft[] = []
  const skipped: SkippedPage[] = []

  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string')
    const paras = slideParagraphs(xml)
    const body = paras.join('\n')

    // ── 复查核销页 ──
    if (REVIEW_RE.test(body)) {
      const issueNo = body.match(REVIEW_ISSUE_NO_RE)?.[2]
      const quote = body.match(REVIEW_QUOTE_RE)?.[1] ?? ''
      const conclusion = body.match(REVIEW_CONCLUSION_RE)?.[0] ?? '经查，车间整改核销属实。'

      // 引述内：「<时间>分检查<车间>，<问题片段>」
      const quoteTime = quote.match(TIME_RE)
      const quoteWorkshop = extractWorkshop(quote)
      const snippet = quote
        .replace(TIME_RE, '')
        .replace(/分?检\s*查/, '')
        .replace(/^[^，,]{2,20}?车间[，,]?/, '')
        .replace(/[，,…\s]+$/, '')
        .trim()

      // 页首时间为复查时间（作为闭环时间）
      const pageTime = body.match(TIME_RE)
      const workshop = extractWorkshop(body) ?? quoteWorkshop

      reviews.push({
        key: `${file.name}-review-${name}`,
        issueNoGuess: issueNo,
        workshop,
        foundAtGuess: quoteTime ? toIso(year, quoteTime[1], quoteTime[2], quoteTime[3], quoteTime[4]) : undefined,
        closedAtGuess: pageTime ? toIso(year, pageTime[1], pageTime[2], pageTime[3], pageTime[4]) : undefined,
        snippet,
        conclusion,
        accepted: true,
        // 复查页照片即整改后照片，核销确认时追加到命中隐患
        photos: await slidePhotos(zip, name, xml),
      })
      continue
    }

    // ── 问题页 ──
    if (!PROBLEM_RE.test(body)) {
      // 未识别页：记录页码、原因与文本预览，导入时展示给人工核对，防止漏网
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

    // 正文段落：剔除页末图片说明，避免 caption 混入描述（多问题页尤其明显）
    const contentParas = stripCaptions(paras)
    const segments = splitMultiProblem(contentParas.join('\n'))
    const multi = segments.length > 1
    const photosBySegment = distributePhotos(await slidePhotos(zip, name, xml), segments.length)

    segments.forEach((seg, idx) => {
      // 单问题页：页末图片说明做标题；多问题页：各段首句截断
      const caption = multi ? undefined : pickCaption(paras.slice(1))
      const description = multi ? seg : contentParas.join('\n')

      let title = caption
      if (!title) {
        // 首句截断做标题：先剥掉"时间+检查+车间"前缀，避免标题带原始时间
        const core = (multi ? seg.replace(/.*?存在问题[：:]/, '') : description)
          .replace(/^\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*\d{1,2}\s*[:：]\s*\d{2}\s*分?/, '')
          .replace(/^检\s*查[^，,]{2,20}?车间[，,]?/, '')
        const firstSentence = core.split('。')[0] ?? core
        title = firstSentence.length > 30 ? `${firstSentence.slice(0, 30)}…` : firstSentence
      }
      if (workshop && !title.includes(workshop)) title = `${workshop} · ${title}`

      drafts.push({
        key: `${file.name}-slide-${name}${multi ? `-${idx}` : ''}`,
        title,
        description,
        locationGuess: workshop,
        categoryGuess: guessCategory(seg, sanwei),
        riskLevel: guessRisk(seg),
        accepted: true,
        foundAtGuess,
        photos: photosBySegment[idx],
      })
    })
  }

  return { drafts, reviews, skipped }
}
