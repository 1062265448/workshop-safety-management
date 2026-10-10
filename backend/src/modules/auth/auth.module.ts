import { Body, Controller, ForbiddenException, Get, Post, Res, UnauthorizedException, UseGuards, Request } from '@nestjs/common'
import { Injectable, Module, SetMetadata } from '@nestjs/common'
import { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { PrismaService } from '../../prisma.service'

// ─────────────────────────────────────────────────────────────
// 认证模块：JWT 登录 + 全局守卫
// @Public() 标记的端点跳过鉴权（登录接口本身）
// ─────────────────────────────────────────────────────────────

export const IS_PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

// ── 基于角色的访问控制（RBAC）──
// @Roles('admin') 显式声明端点角色；未声明时：GET 任意登录用户可读，
// 非 GET（写操作）要求 admin 或 safety_officer —— viewer 为只读角色
export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

/** 密码策略：≥8 位且同时含字母与数字 */
export function assertPasswordPolicy(password: string) {
  if (typeof password !== 'string' || password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new UnauthorizedException('密码至少 8 位，且需同时包含字母和数字')
  }
}

// 照片访问令牌 Cookie：HttpOnly + SameSite=Strict，Path 限定 /uploads，
// 仅供 <img> 等无法携带 Authorization 头的静态请求使用；API 仍走 Bearer
export const UPLOAD_COOKIE = 'wsms_upload'
function uploadCookieOptions(req: { secure: boolean; headers: Record<string, unknown> }) {
  const https = req.secure || req.headers['x-forwarded-proto'] === 'https'
  return { httpOnly: true, sameSite: 'strict' as const, secure: https, path: '/uploads', maxAge: 7 * 24 * 3600 * 1000 }
}

const JWT_SECRET = process.env.JWT_SECRET || 'wsms-dev-secret-change-me'
const JWT_EXPIRES = '7d'

// 公网部署必须通过环境变量 JWT_SECRET 设置强密钥，否则令牌可被伪造
if (!process.env.JWT_SECRET) {
  console.warn('[安全警告] 未设置 JWT_SECRET 环境变量，正在使用开发默认密钥。公网部署前务必在 .env 中配置强随机密钥！')
}

// 登录限流（防暴力破解）：同一 IP 连续失败 5 次锁定 60 秒
const loginFails = new Map<string, { count: number; lockedUntil: number }>()
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MS = 60_000

function checkLoginThrottle(ip: string) {
  const rec = loginFails.get(ip)
  if (rec && rec.lockedUntil > Date.now()) {
    throw new UnauthorizedException('尝试次数过多，请 1 分钟后再试')
  }
}

function recordLoginFail(ip: string) {
  const rec = loginFails.get(ip) ?? { count: 0, lockedUntil: 0 }
  rec.count += 1
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.count = 0
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS
  }
  loginFails.set(ip, rec)
}

function clearLoginFail(ip: string) {
  loginFails.delete(ip)
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { username } })
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('用户名或密码错误')
    }
    const token = await this.jwt.signAsync({ sub: user.id, username: user.username, role: user.role })
    return { token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } }
  }

  /** 修改密码 */
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
      throw new UnauthorizedException('原密码错误')
    }
    if (oldPassword === newPassword) throw new UnauthorizedException('新密码不能与原密码相同')
    assertPasswordPolicy(newPassword)
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    })
    return { ok: true }
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true
    const req = ctx.switchToHttp().getRequest()
    // API 请求走 Authorization: Bearer；照片等静态请求走 HttpOnly Cookie（手工解析，免 cookie-parser 依赖）
    const bearer = (req.headers.authorization as string | undefined)?.replace(/^Bearer /, '')
    let cookieToken: string | undefined
    const cookieHeader = req.headers.cookie as string | undefined
    if (cookieHeader) {
      for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0 && part.slice(0, eq).trim() === UPLOAD_COOKIE) {
          cookieToken = decodeURIComponent(part.slice(eq + 1).trim())
          break
        }
      }
    }
    const token = bearer || cookieToken
    if (!token) throw new UnauthorizedException('未登录')
    try {
      req.user = await this.jwt.verifyAsync(token, { secret: JWT_SECRET })
      return true
    } catch {
      throw new UnauthorizedException('登录已过期')
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true
    const req = ctx.switchToHttp().getRequest()
    const role = req.user?.role as string | undefined
    if (!role) return true // 未认证请求交给 AuthGuard 拦截
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()])
    if (required?.length) {
      if (required.includes(role)) return true
      throw new ForbiddenException('需要权限：' + required.join(' / '))
    }
    // 默认策略：viewer 只读；写操作需要 admin 或 safety_officer
    if (req.method !== 'GET' && role === 'viewer') {
      throw new ForbiddenException('查看者角色仅可浏览，不能修改数据')
    }
    return true
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() body: { username?: string; password?: string },
    @Request() req: { ip?: string; secure: boolean; headers: Record<string, unknown>; cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: { cookie: (name: string, value: string, opts: object) => void; clearCookie: (name: string, opts: object) => void },
  ) {
    if (!body.username || !body.password) throw new UnauthorizedException('请输入用户名和密码')
    const ip = req.ip ?? 'unknown'
    checkLoginThrottle(ip)
    try {
      const result = await this.svc.login(body.username, body.password)
      clearLoginFail(ip)
      // 下发照片访问 Cookie（HttpOnly，仅 /uploads 路径，API 仍用 Bearer token）
      res.cookie(UPLOAD_COOKIE, result.token, uploadCookieOptions(req))
      return result
    } catch (e) {
      recordLoginFail(ip)
      throw e
    }
  }

  @Public()
  @Post('logout')
  logout(@Res({ passthrough: true }) res: { clearCookie: (name: string, opts: object) => void }) {
    res.clearCookie(UPLOAD_COOKIE, { path: '/uploads' })
    return { ok: true }
  }

  @Get('me')
  me(@Request() req: { user: { username: string; role: string } }) {
    return req.user
  }

  @Post('change-password')
  changePassword(@Request() req: { user: { sub: string } }, @Body() body: { oldPassword: string; newPassword: string }) {
    return this.svc.changePassword(req.user.sub, body.oldPassword, body.newPassword)
  }
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: JWT_EXPIRES } })],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, RolesGuard, PrismaService],
  exports: [AuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
