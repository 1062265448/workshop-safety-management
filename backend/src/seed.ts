import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // 内置标签
  const categories = ['电气安全', '消防安全', '机械设备', '危化品', '作业环境', '防护用具']
  const locations = ['一号车间', '二号车间', '装配线', '仓库', '配电房']
  const palette = ['#007AFF', '#FF9500', '#FF3B30', '#AF52DE', '#34C759', '#5AC8FA']

  const tagCount = await prisma.tag.count()
  if (tagCount === 0) {
    await prisma.tag.createMany({
      data: [
        ...categories.map((name, i) => ({ name, group: 'category', color: palette[i % palette.length], builtin: true })),
        ...locations.map((name) => ({ name, group: 'location', color: '#5856D6', builtin: true })),
      ],
    })
    console.log('seeded builtin tags')
  }

  // 检查计划
  const planCount = await prisma.inspectionPlan.count()
  if (planCount === 0) {
    const day = 86_400_000
    const now = Date.now()
    await prisma.inspectionPlan.createMany({
      data: [
        {
          name: '每日班前安全检查', scope: '全部车间 · 作业环境', frequency: 'daily',
          nextRunAt: new Date(now + day), checklist: ['通道畅通', '设备防护完好', '劳保穿戴'],
          remindBeforeMinutes: 30, enabled: true,
        },
        {
          name: '每周消防专项检查', scope: '全部区域 · 消防安全', frequency: 'weekly',
          nextRunAt: new Date(now + 3 * day), checklist: ['灭火器压力', '消火栓完好', '疏散指示'],
          remindBeforeMinutes: 120, enabled: true,
        },
      ],
    })
    console.log('seeded inspection plans')
  }

  // 管理员账号：仅在没有用户时创建。密码不再硬编码——
  // 优先取环境变量 ADMIN_USERNAME / ADMIN_PASSWORD；未配置则生成强随机口令并打印一次
  const userCount = await prisma.user.count()
  if (userCount === 0) {
    const bcrypt = await import('bcryptjs')
    const crypto = await import('crypto')
    const username = (process.env.ADMIN_USERNAME ?? 'wsms_admin').trim()
    let password = process.env.ADMIN_PASSWORD
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url')
      console.log(`[首次部署] 已生成随机管理员密码（仅此一次显示，请立即记录并登录后修改）：${password}`)
    }
    await prisma.user.create({
      data: {
        username,
        passwordHash: await bcrypt.hash(password, 10),
        displayName: '安全管理员',
        role: 'admin',
      },
    })
    console.log(`seeded admin user (${username})`)
  }

  console.log('seed done')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
