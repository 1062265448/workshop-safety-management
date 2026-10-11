import { join } from 'path'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ServeStaticModule } from '@nestjs/serve-static'
import { AuthGuard, RolesGuard, AuthModule } from './modules/auth/auth.module'
import { IssuesModule } from './modules/issues/issues.module'
import { TagsModule } from './modules/tags/tags.module'
import { PlansModule } from './modules/plans/plans.module'
import { RemindersModule } from './modules/reminders/reminders.module'
import { AnnotationsModule } from './modules/annotations/annotations.module'
import { UploadsModule } from './modules/uploads/uploads.module'
import { UsersModule } from './modules/users/users.module'

@Module({
  imports: [
    // 生产模式：后端托管前端打包产物，整站单端口。
    // /uploads 照片不再由静态目录直出，而是走 UploadsController 控制器
    // （在 main.ts 中将 uploads/:file 排除出全局 /api 前缀），由 JWT 守卫鉴权后 sendFile。
    // exclude 必须同时排除 /api 与 /uploads，否则会被 SPA 的 index.html 通配回退截胡。
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'app', 'dist'),
      exclude: ['/api/(.*)', '/uploads/(.*)'],
      serveStaticOptions: {
        // Vite 产物文件名带内容哈希（index-xxx.js），内容变则文件名变——
        // 长缓存 immutable：内网/公网重复访问只下载一次，之后全部走本地缓存
        setHeaders: (res, path) => {
          if (path.replace(/\\/g, '/').includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          }
        },
      },
    }),
    AuthModule,
    IssuesModule,
    TagsModule,
    PlansModule,
    RemindersModule,
    AnnotationsModule,
    UploadsModule,
    UsersModule,
  ],
  providers: [
    // 全局守卫：AuthGuard 先认证，RolesGuard 再按角色授权（@Roles 显式声明 > 默认 viewer 只读）
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
