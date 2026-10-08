import { Body, Controller, Get, Post, UnauthorizedException, UseGuards, Request } from '@nestjs/common'
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
    const token = (req.headers.authorization as string | undefined)?.replace(/^Bearer /, '')
    if (!token) throw new UnauthorizedException('未登录')
    try {
      req.user = await this.jwt.verifyAsync(token, { secret: JWT_SECRET })
      return true
    } catch {
      throw new UnauthorizedException('登录已过期')
    }
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() body: { username?: string; password?: string }, @Request() req: { ip?: string }) {
    if (!body.username || !body.password) throw new UnauthorizedException('请输入用户名和密码')
    const ip = req.ip ?? 'unknown'
    checkLoginThrottle(ip)
    try {
      const result = await this.svc.login(body.username, body.password)
      clearLoginFail(ip)
      return result
    } catch (e) {
      recordLoginFail(ip)
      throw e
    }
  }

  @Get('me')
  me(@Request() req: { user: { username: string; role: string } }) {
    return req.user
  }

  @Post('change-password')
  changePassword(@Request() req: { user: { sub: string } }, @Body() body: { oldPassword: string; newPassword: string }) {
    if (!body.newPassword || body.newPassword.length < 6) throw new UnauthorizedException('新密码至少 6 位')
    return this.svc.changePassword(req.user.sub, body.oldPassword, body.newPassword)
  }
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: JWT_EXPIRES } })],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, PrismaService],
  exports: [AuthGuard, JwtModule],
})
export class AuthModule {}
