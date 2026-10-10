import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Request } from '@nestjs/common'
import { BadRequestException, ForbiddenException, Injectable, Module } from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { PrismaService } from '../../prisma.service'
import { Roles } from '../auth/auth.module'

// ─────────────────────────────────────────────────────────────
// 用户管理（仅 admin）：列表 / 新建 / 编辑 / 重置密码 / 删除
// 安全约束：不能删除或降级自己；系统必须始终保留至少一名 admin
// ─────────────────────────────────────────────────────────────

const ROLES = ['admin', 'safety_officer', 'viewer'] as const
type Role = (typeof ROLES)[number]

/** 密码策略：≥8 位且同时含字母与数字（与 auth 模块一致） */
export function assertPasswordPolicy(password: string) {
  if (typeof password !== 'string' || password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new BadRequestException('密码至少 8 位，且需同时包含字母和数字')
  }
}

function assertUsername(username: string) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{2,20}$/.test(username)) {
    throw new BadRequestException('用户名需为 2-20 位字母、数字或下划线')
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({
      select: { id: true, username: true, displayName: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(body: { username?: string; password?: string; displayName?: string; role?: string }) {
    const username = (body.username ?? '').trim()
    const role = (body.role ?? 'safety_officer') as Role
    assertUsername(username)
    if (!ROLES.includes(role)) throw new BadRequestException('角色不合法')
    assertPasswordPolicy(body.password ?? '')
    const exists = await this.prisma.user.findUnique({ where: { username } })
    if (exists) throw new ConflictException(`用户名「${username}」已存在`)
    return this.prisma.user.create({
      data: {
        username,
        passwordHash: await bcrypt.hash(body.password as string, 10),
        displayName: (body.displayName ?? '').trim(),
        role,
      },
      select: { id: true, username: true, displayName: true, role: true, createdAt: true },
    })
  }

  /** 编辑显示名/角色；不能修改自己的角色，且必须保留至少一名 admin */
  async update(id: string, actorId: string, body: { displayName?: string; role?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException('用户不存在')
    if (body.role !== undefined && !ROLES.includes(body.role as Role)) throw new BadRequestException('角色不合法')
    if (id === actorId && body.role !== undefined && body.role !== user.role) {
      throw new ForbiddenException('不能修改自己的角色')
    }
    if (body.role && body.role !== 'admin' && user.role === 'admin') {
      await this.assertAnotherAdminRemains(id)
    }
    return this.prisma.user.update({
      where: { id },
      data: {
        displayName: body.displayName !== undefined ? body.displayName.trim() : undefined,
        role: body.role as Role | undefined,
      },
      select: { id: true, username: true, displayName: true, role: true, createdAt: true },
    })
  }

  /** 管理员重置他人密码 */
  async resetPassword(id: string, actorId: string, password: string) {
    if (id === actorId) throw new ForbiddenException('修改自己的密码请用「修改密码」入口')
    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException('用户不存在')
    assertPasswordPolicy(password)
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(password, 10) } })
    return { ok: true }
  }

  /** 删除用户：不能删自己；删除 admin 前确认还有其他 admin */
  async remove(id: string, actorId: string) {
    if (id === actorId) throw new ForbiddenException('不能删除当前登录账号')
    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException('用户不存在')
    if (user.role === 'admin') await this.assertAnotherAdminRemains(id)
    await this.prisma.user.delete({ where: { id } })
    return { ok: true }
  }

  private async assertAnotherAdminRemains(excludeId: string) {
    const admins = await this.prisma.user.count({ where: { role: 'admin', id: { not: excludeId } } })
    if (admins === 0) throw new ForbiddenException('系统必须保留至少一名管理员')
  }
}

@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get()
  list() {
    return this.svc.list()
  }

  @Post()
  create(@Body() body: { username?: string; password?: string; displayName?: string; role?: string }) {
    return this.svc.create(body)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { displayName?: string; role?: string }, @Request() req: { user: { sub: string } }) {
    return this.svc.update(id, req.user.sub, body)
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { password?: string }, @Request() req: { user: { sub: string } }) {
    return this.svc.resetPassword(id, req.user.sub, body.password ?? '')
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    return this.svc.remove(id, req.user.sub)
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService, PrismaService],
})
export class UsersModule {}
