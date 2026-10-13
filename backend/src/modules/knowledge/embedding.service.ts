// ─────────────────────────────────────────────────────────────
// 本地嵌入服务：bge-large-zh-v1.5（1024 维）经 transformers.js 在本机运行
// 模型文件需提前放到 EMBEDDING_MODEL_DIR（默认 backend/models/bge-large-zh-v1.5）
// 完全离线，隐患/通报等厂内数据不出本机
// ─────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

export const EMBEDDING_DIM = 1024
const MODEL_DIR = resolve(process.env.EMBEDDING_MODEL_DIR || join(process.cwd(), 'models', 'bge-large-zh-v1.5'))

@Injectable()
export class EmbeddingService {
  private extractor: any = null
  private loading: Promise<void> | null = null

  /** 模型文件是否就绪（不触发加载） */
  get ready(): boolean {
    return existsSync(join(MODEL_DIR, 'config.json')) && existsSync(join(MODEL_DIR, 'onnx', 'model_quantized.onnx'))
  }

  get modelDir(): string {
    return MODEL_DIR
  }

  /** 懒加载模型（首次约几秒，之后常驻内存） */
  private async ensureLoaded() {
    if (this.extractor) return
    if (!this.loading) {
      this.loading = (async () => {
        // 动态引入：模型未就绪时不影响其余模块启动
        const { pipeline, env } = await import('@huggingface/transformers')
        env.allowRemoteModels = false // 只用本地模型文件，运行期不联网
        env.localModelPath = resolve(MODEL_DIR, '..') + '/'
        this.extractor = await pipeline('feature-extraction', 'bge-large-zh-v1.5', { dtype: 'q8' })
      })()
    }
    await this.loading
  }

  /** 文本 → 1024 维归一化向量；bge 中文模型对查询句加指令前缀效果更好 */
  async embed(texts: string[], isQuery = false): Promise<number[][]> {
    if (!this.ready) throw new Error(`嵌入模型文件缺失：${MODEL_DIR}（请先下载模型，见部署文档知识库章节）`)
    await this.ensureLoaded()
    // 模型上限 512 token：超长文本硬截断兜底（中文约 1 字 ≈ 1 token，留 32 token 余量）
    const capped = texts.map((t) => (t.length > 480 ? t.slice(0, 480) : t))
    const prefixed = isQuery ? capped.map((t) => '为这个句子生成表示以用于检索相关文章：' + t) : capped
    const out = await this.extractor(prefixed, { pooling: 'mean', normalize: true })
    return out.tolist() as number[][]
  }
}
