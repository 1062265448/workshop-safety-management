import type { PlanFrequency } from '@/types'

/** 本系统的管理对象：成品车间。其他车间的通报问题仅作参考存档 */
export const MANAGED_WORKSHOP = '成品车间'

/**
 * 检查计划「频次模板」：预置厂"一线工作法"规定的各级检查频次。
 * 仅前端快捷填充用，不落库；选择后自动填计划名称与周期，用户可再改。
 * 现有周期字段只有 daily/weekly/monthly/quarterly 四档，"每周3次""每班2次"
 * 等细粒度频次以文字形式并入计划名称（如"车间主任巡查（每周3次）"），
 * 周期映射到最接近的一档。
 */
export interface PlanFrequencyTemplate {
  key: string
  /** chip 上显示的名称 */
  label: string
  /** 填充进"计划名称"的频次说明（并入名称，保留细粒度信息） */
  timesText: string
  /** 映射到现有周期字段的档位 */
  frequency: PlanFrequency
  /** 是否空白自定义 */
  custom?: boolean
}

export const PLAN_FREQUENCY_TEMPLATES: PlanFrequencyTemplate[] = [
  { key: 'director', label: '车间主任巡查', timesText: '每周3次', frequency: 'weekly' },
  { key: 'engineer', label: '管理/工程人员巡查', timesText: '每工作日1次', frequency: 'daily' },
  { key: 'teamlead', label: '班组长班中检查', timesText: '每班1次', frequency: 'daily' },
  { key: 'worker', label: '岗位工人自查', timesText: '每班2次', frequency: 'daily' },
  { key: 'dept', label: '厂专业部室检查', timesText: '每月1次', frequency: 'monthly' },
  { key: 'custom', label: '自定义', timesText: '', frequency: 'weekly', custom: true },
]

/** 判定车间名是否属于本系统管理范围 */
export function isManagedWorkshop(workshopName?: string): boolean {
  return !!workshopName && workshopName.includes('成品')
}

/** 成品车间责任班组 */
export const TEAMS = ['控运班', '机组班', '加工班', '职能组'] as const

/** 统计网格责任人在成品车间隐患中的出现次数（用于 ≥2 次重复提醒；正面典型不计入） */
export function countGridOwners(issues: Array<{ scope: string; gridOwner?: string; isGood?: boolean }>): Map<string, number> {
  const map = new Map<string, number>()
  for (const i of issues) {
    const name = i.gridOwner?.trim()
    if (i.scope === 'managed' && !i.isGood && name) map.set(name, (map.get(name) ?? 0) + 1)
  }
  return map
}

/** 网格责任人重复分级：2 次=普通提醒（橙），≥3 次=严重提醒/加倍考核（红） */
export function gridOwnerTier(count: number): 'warn' | 'severe' | null {
  if (count >= 3) return 'severe'
  if (count >= 2) return 'warn'
  return null
}

/** 将标签按父子关系展开：父标签后紧跟其子标签（下拉框分组排列用），depth=1 为子标签 */
export function withSubTags<T extends { id: string; parentId?: string | null }>(tags: T[]): Array<{ tag: T; depth: number }> {
  const out: Array<{ tag: T; depth: number }> = []
  for (const p of tags.filter((t) => !t.parentId)) {
    out.push({ tag: p, depth: 0 })
    for (const c of tags.filter((t) => t.parentId === p.id)) out.push({ tag: c, depth: 1 })
  }
  return out
}
