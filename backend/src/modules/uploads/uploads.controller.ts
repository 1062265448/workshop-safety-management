import { extname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { BadRequestException, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common'
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
}
