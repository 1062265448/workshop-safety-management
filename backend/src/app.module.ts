import { join } from 'path'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ServeStaticModule } from '@nestjs/serve-static'
import { AuthGuard, AuthModule } from './modules/auth/auth.module'
import { IssuesModule } from './modules/issues/issues.module'
import { TagsModule } from './modules/tags/tags.module'
import { PlansModule } from './modules/plans/plans.module'
import { RemindersModule } from './modules/reminders/reminders.module'
import { AnnotationsModule } from './modules/annotations/annotations.module'
import { UploadsModule } from './modules/uploads/uploads.module'
import { UPLOADS_DIR } from './modules/uploads/uploads.controller'

@Module({
  imports: [
    // 生产模式：后端托管前端打包产物，整站单端口（API 在 /api 前缀下，不受影响）
    // 注意顺序：/uploads 照片目录必须在前，否则会被前端 SPA 的 index.html 通配回退截胡
    ServeStaticModule.forRoot(
      { rootPath: UPLOADS_DIR, serveRoot: '/uploads' },
      { rootPath: join(__dirname, '..', '..', 'app', 'dist') },
    ),
    AuthModule,
    IssuesModule,
    TagsModule,
    PlansModule,
    RemindersModule,
    AnnotationsModule,
    UploadsModule,
  ],
  providers: [
    // 全局 JWT 守卫：除 @Public() 端点外一律要求登录
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
