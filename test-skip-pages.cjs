// 验证 parsePptx 的页面分类逻辑（含未识别页记录），复刻其正则与文本提取规则
const JSZip = require('D:\\2026\\车间安全管理系统\\app\\node_modules\\jszip')
const fs = require('fs')
const path = require('path')

const PROBLEM_RE = /不符合《|存在[^。]{0,40}(风险|隐患|漏洞)|现场纠偏|不认真、不仔细|流于形式|不到位|未排查出/
const REVIEW_RE = /复查厂?安全督查通报/

function cleanParagraph(s) {
  return s.replace(/\s+/g, ' ').replace(/([一-龥]) (?=[一-龥])/g, '$1')
    .replace(/([0-9]) (?=[:：])/g, '$1').replace(/([:：]) (?=[0-9])/g, '$1').trim()
}

// 近似 slideParagraphs：按 <a:p> 分段，段内拼接 <a:t>
function slideParagraphs(xml) {
  const paras = []
  for (const pm of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...pm[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => r[1])
    const text = cleanParagraph(runs.join(''))
    if (text) paras.push(text)
  }
  return paras
}

async function main() {
  const dir = 'D:\\2026\\车间安全管理系统\\厂督察通报'
  for (const fname of fs.readdirSync(dir).filter((f) => f.endsWith('.pptx'))) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, fname)))
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    let problems = 0, reviews = 0
    const skipped = []
    for (const name of slideNames) {
      const xml = await zip.file(name).async('string')
      const body = slideParagraphs(xml).join('\n')
      if (REVIEW_RE.test(body)) { reviews++; continue }
      if (PROBLEM_RE.test(body)) { problems++; continue }
      const page = Number(name.match(/\d+/)[0])
      const hasPhotos = /<a:blip[^>]*r:embed=/.test(xml)
      skipped.push({
        page,
        reason: !body.trim() ? (hasPhotos ? '纯图片页，无文本' : '空白页') : '未含问题或复查句式',
        preview: body.replace(/\n/g, ' ').slice(0, 60),
      })
    }
    console.log(`\n=== ${fname}`)
    console.log(`问题页 ${problems} · 复查页 ${reviews} · 未识别 ${skipped.length}`)
    for (const s of skipped) console.log(`  第${s.page}页 [${s.reason}] ${s.preview}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
