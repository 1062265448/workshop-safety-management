import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { RequestMethod, ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import compression from 'compression'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  // 全局 /api 前缀；/uploads/:file 照片下载除外（控制器在 /api 之外，供 <img> 同源访问）
  app.setGlobalPrefix('api', { exclude: [{ path: 'uploads/:file', method: RequestMethod.GET }] })
  // 反向代理（Caddy/Nginx）后获取真实访客 IP，登录限流按真实 IP 计数
  app.set('trust proxy', true)
  // 单端口同源架构（后端托管前端），无需放开跨域；公网部署杜绝任意来源调用 API
  app.enableCors({ origin: false })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  // 请求体上限放宽到 10MB：默认 100kb，整文件夹批量导入后一次预标注/查重的
  // JSON（几百条草稿的标题+描述）会超过限触发 413 Payload Too Large
  app.useBodyParser('json', { limit: '10mb' })
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true })

  // gzip 压缩：公网隧道带宽小（家庭宽带上行），1.5MB JS 压到约 1/4，首屏明显变快
  app.use(compression())

  // 安全响应头（轻量 helmet）：公网暴露的基本防线
  app.use((req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'",
    )
    next()
  })

  const port = Number(process.env.PORT) || 3100
  // 绑定 0.0.0.0，允许局域网/服务器反向代理访问
  await app.listen(port, '0.0.0.0')
  console.log(`WSMS backend listening on http://0.0.0.0:${port}/api`)
}
bootstrap()
