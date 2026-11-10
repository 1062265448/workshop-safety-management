import { Body, Controller, ForbiddenException, Get, Post, Res, UnauthorizedException, Request } from '@nestjs/common'
import { Injectable, Module, SetMetadata } from '@nestjs/common'
import { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { PrismaService } from '../../prisma.service'

// ─────────────────────────────────────────────────────────────
// 认证模块：JWT 登录 + 全局守卫
// @Public() 标记的端点跳过鉴权（登录接口本身）
// Setting 表保存每用户随机会话版本，无需修改 User schema。
// ─────────────────────────────────────────────────────────────

export const IS_PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

/** 密码策略：≥8 位且同时含字母与数字 */
export function assertPasswordPolicy(password: string) {
  if (typeof password !== 'string' || password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new UnauthorizedException('密码至少 8 位，且需同时包含字母和数字')
  }
}

export const UPLOAD_COOKIE = 'wsms_upload'
function uploadCookieOptions(req: { secure: boolean; headers: Record<string, unknown> }) {
  const https = req.secure || req.headers['x-forwarded-proto'] === 'https'
  return { httpOnly: true, sameSite: 'strict' as const, secure: https, path: '/uploads', maxAge: 7 * 24 * 3600 * 1000 }
}

const DEV_JWT_SECRET = 'wsms-dev-secret-change-me'
const KNOWN_WEAK_SECRETS = new Set([
  DEV_JWT_SECRET,
  'change-me',
  'changeme',
  'secret',
  'jwt-secret',
  'your-secret-key',
  '请替换为强随机字符串',
])
const JWT_EXPIRES = '7d'

export function isWeakJwtSecret(secret: string | undefined): boolean {
  const value = secret?.trim() ?? ''
  return value.length < 32 || KNOWN_WEAK_SECRETS.has(value.toLowerCase())
}

/** 模块加载时即校验；生产弱密钥直接阻止 Nest 启动。 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.JWT_SECRET?.trim()
  if (env.NODE_ENV === 'production' && isWeakJwtSecret(configured)) {
    throw new Error('生产环境必须设置至少 32 字符且非默认值的 JWT_SECRET')
  }
  return configured || DEV_JWT_SECRET
}

const JWT_SECRET = resolveJwtSecret()
if (isWeakJwtSecret(process.env.JWT_SECRET)) {
  console.warn('[安全警告] JWT_SECRET 未设置或强度不足，仅限开发使用；生产启动将拒绝此配置。')
}

export const authTokenVersionKey = (userId: string) => `auth_token_version:${userId}`
export const nextAuthTokenVersion = () => randomUUID()

interface AuthTokenPayload {
  sub: string
  username: string
  role: string
  tv: string
}

/** 兼容未来增加的禁用字段；当前 schema 下用户删除仍由实时 User 查询拦截。 */
function userIsDisabled(user: Record<string, unknown>): boolean {
  return user.enabled === false || user.disabled === true || user.disabledAt != null || user.deletedAt != null || user.status === 'disabled'
}

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
    if (!user || userIsDisabled(user as unknown as Record<string, unknown>) || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('用户名或密码错误')
    }
    const version = await this.prisma.setting.findUnique({ where: { key: authTokenVersionKey(user.id) } })
    const token = await this.jwt.signAsync({ sub: user.id, username: user.username, role: user.role, tv: version?.value || '0' })
    return { token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } }
  }

  /** 修改密码与提升会话版本须原子完成，确保旧 Bearer 和上传 Cookie 立即失效。 */
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
      throw new UnauthorizedException('原密码错误')
    }
    if (oldPassword === newPassword) throw new UnauthorizedException('新密码不能与原密码相同')
    assertPasswordPolicy(newPassword)
    const passwordHash = await bcrypt.hash(newPassword, 10)
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } })
      await tx.setting.upsert({
        where: { key: authTokenVersionKey(userId) },
        create: { key: authTokenVersionKey(userId), value: nextAuthTokenVersion() },
        update: { value: nextAuthTokenVersion() },
      })
    })
    return { ok: true }
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // 公开登录/登出必须先放行，不进行任何用户或 token version 查询。
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true
    const req = ctx.switchToHttp().getRequest()
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

    let payload: AuthTokenPayload
    try {
      payload = await this.jwt.verifyAsync<AuthTokenPayload>(token, { secret: JWT_SECRET })
    } catch {
      throw new UnauthorizedException('登录已过期')
    }
    if (!payload.sub || !payload.tv) throw new UnauthorizedException('登录已失效，请重新登录')

    // 每次请求核对用户及版本：删除/禁用、角色变化、改密均不等待 JWT 自然过期。
    const [user, version] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
      this.prisma.setting.findUnique({ where: { key: authTokenVersionKey(payload.sub) } }),
    ])
    if (
      !user || userIsDisabled(user as unknown as Record<string, unknown>) ||
      user.username !== payload.username || user.role !== payload.role ||
      (version?.value || '0') !== payload.tv
    ) {
      throw new UnauthorizedException('账号状态或凭据已变化，请重新登录')
    }
    req.user = { sub: user.id, username: user.username, role: user.role, tv: payload.tv }
    return true
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
    if (!role) return true
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()])
    if (required?.length) {
      if (required.includes(role)) return true
      throw new ForbiddenException('需要权限：' + required.join(' / '))
    }
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
