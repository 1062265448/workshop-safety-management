import { parseFile } from './parsers'

// ─────────────────────────────────────────────────────────────
// 文档解析 Web Worker：JSZip 解压 + 逐页 XML 识别全程在后台线程执行，
// 主线程（页面交互/进度动画）不被阻塞；大通报 PPT 解析期间页面可正常操作。
// 消息协议：{ type: 'progress', done, total } | { type: 'done', result } | { type: 'error', message }
// ─────────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const { file } = e.data
  try {
    const result = await parseFile(file, (done, total) => {
      ;(self as unknown as Worker).postMessage({ type: 'progress', done, total })
    })
    ;(self as unknown as Worker).postMessage({ type: 'done', result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : '解析失败',
    })
  }
}
