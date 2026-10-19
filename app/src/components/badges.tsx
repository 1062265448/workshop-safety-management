import type { CauseType, CountermeasureLevel, IssueSource, IssueStage, IssueStatus, RiskLevel } from '@/types'
import { cn } from '@/lib/utils'

export const RISK_LABEL: Record<RiskLevel, string> = { general: '一般', critical: '重大', immediate: '即知即改' }
export const RISK_COLOR: Record<RiskLevel, string> = {
  general: 'bg-[#34C759]/12 text-[#248A3D]',
  critical: 'bg-[#FF3B30]/12 text-[#D70015]',
  immediate: 'bg-[#007AFF]/12 text-[#007AFF]',
}

export const STATUS_LABEL: Record<IssueStatus, string> = { pending: '待整改', fixing: '整改中', review: '待复查', closed: '已闭环' }
export const STATUS_COLOR: Record<IssueStatus, string> = {
  pending: 'bg-neutral-500/10 text-neutral-600',
  fixing: 'bg-[#007AFF]/12 text-[#007AFF]',
  review: 'bg-[#AF52DE]/12 text-[#8944AB]',
  closed: 'bg-[#34C759]/12 text-[#248A3D]',
}

export const SOURCE_LABEL: Record<IssueSource, string> = { manual: '手动录入', pptx: 'PPT 导入', docx: '文档导入', xlsx: '表格导入' }

/** 戴明 94/6 根因类别 */
export const CAUSE_TYPE_LABEL: Record<CauseType, string> = { system: '系统原因', individual: '个人原因' }
/** 对策层级（机制 → 技术 → 管理） */
export const COUNTERMEASURE_LABEL: Record<CountermeasureLevel, string> = { mechanism: '机制', technical: '技术', management: '管理' }
/** 整改闭环阶段 */
export const STAGE_LABEL: Record<IssueStage, string> = {
  rechecking: '复查中',
  institutionalizing: '制度沉淀',
  educating: '教育职工',
  executing: '规范执行',
  done: '闭环完成',
}
export const STAGE_ORDER: IssueStage[] = ['rechecking', 'institutionalizing', 'educating', 'executing', 'done']

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={cn('px-2 py-0.5 rounded-md text-[12px] font-medium', RISK_COLOR[level])}>{RISK_LABEL[level]}</span>
}

export function StatusBadge({ status, overdue }: { status: IssueStatus; overdue?: boolean }) {
  if (overdue) {
    return <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-[#FF3B30]/12 text-[#D70015]">已逾期</span>
  }
  return <span className={cn('px-2 py-0.5 rounded-md text-[12px] font-medium', STATUS_COLOR[status])}>{STATUS_LABEL[status]}</span>
}
