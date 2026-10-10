import { extname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res, UploadedFiles, UseInterceptors } from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'

/** 照片落盘目录：backend/uploads（随后端工作目录，服务器迁移时整体拷贝即可） */
export const UPLOADS_DIR = join(process.cwd(), 'uploads')
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true })

const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'])

@Controller('uploads')
export class UploadsController {
  /** 多图上传：POST /api/uploads，字段名 files，单张 ≤ 10MB，一次最多 9 张 */
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 9, {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase()
        if (!file.mimetype.startsWith('image/') || !ALLOWED.has(ext)) {
          return cb(new BadRequestException('仅支持图片文件（jpg/png/webp/gif/heic）'), false)
        }
        cb(null, true)
      },
    }),
  )
  upload(@UploadedFiles() files: Express.Multer.File[]) {
    return { paths: (files ?? []).map((f) => `/uploads/${f.filename}`) }
  }

  /**
   * 照片下载（根路径）：GET /uploads/:file
   * 该路由在 main.ts 中被排除出全局 /api 前缀，供前端 <img src="/uploads/xxx"> 同源访问；
   * 走全局 JWT 守卫：Authorization Bearer 或登录时下发的 HttpOnly Cookie 均可。
   * 文件名严格白名单（上传时生成的 uuid.ext），杜绝路径穿越。
   */
  @Get('uploads/:file')
  downloadWeb(@Param('file') file: string, @Res() res: { sendFile: (path: string, options: object, cb: (e?: Error) => void) => void }) {
    return this.download(file, res)
  }

  @Get(':file')
  download(@Param('file') file: string, @Res() res: { sendFile: (path: string, options: object, cb: (e?: Error) => void) => void }) {
    if (!/^[a-zA-Z0-9-]{36}\.[a-z0-9]{2,5}$/.test(file)) {
      throw new BadRequestException('非法文件名')
    }
    const full = join(UPLOADS_DIR, file)
    if (!existsSync(full)) throw new NotFoundException('照片不存在')
    res.sendFile(full, {}, (err) => {
      if (err) throw new NotFoundException('照片不存在')
    })
  }
}
