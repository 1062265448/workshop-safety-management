// ─────────────────────────────────────────────────────────────
// 车间安全管理系统 · 核心数据模型
// ─────────────────────────────────────────────────────────────

/** 风险等级（枚举字段，决定默认整改时限） */
export type RiskLevel = 'general' | 'major' | 'critical'

/** 隐患状态机：待整改 → 整改中 → 待复查 → 已闭环；逾期由 deadline 推导 */
export type IssueStatus = 'pending' | 'fixing' | 'review' | 'closed'

/** 录入来源 */
export type IssueSource = 'manual' | 'pptx' | 'docx' | 'xlsx'

/** 管理范围：managed=成品车间（完整闭环），reference=其他车间（仅参考） */
export type IssueScope = 'managed' | 'reference'

/** 隐患问题（系统核心实体） */
export interface SafetyIssue {
  id: string
  title: string
  description: string
  /** 区域标签 id（车间/产线/工位） */
  locationId?: string
  /** 隐患类型标签 id（电气/消防/机械…） */
  categoryId?: string
  /** 自由标签 id 列表 */
  tagIds: string[]
  riskLevel: RiskLevel
  status: IssueStatus
  /** 管理范围：成品车间隐患走整改闭环，其他车间仅参考 */
  scope: IssueScope
  source: IssueSource
  /** 来源文件名（导入时） */
  sourceFile?: string
  /** 排查人 */
  reporter: string
  /** 整改责任人 */
  assignee?: string
  /** 发现日期 ISO */
  foundAt: string
  /** 整改期限 ISO */
  deadline?: string
  /** 闭环日期 ISO */
  closedAt?: string
  /** 整改记录 */
  fixNote?: string
  /** 现场/整改照片路径（/uploads/xxx） */
  photos: string[]
  /** 防复发复查：间隔天数（默认 7，可编辑） */
  recheckIntervalDays: number
  /** 要求复查次数（默认 3） */
  recheckRequired: number
  /** 已完成复查的时间 ISO 列表 */
  rechecks: string[]
  /** 责任班组（成品车间：控运班/机组班/加工班/职能组） */
  team?: string
  /** 网格主操手 */
  gridOperator?: string
  /** 网格责任人（同一责任人 ≥2 次出现会有重复提醒） */
  gridOwner?: string
  /** 系统责任人 */
  systemOwner?: string
  /** 系统原因分析 */
  systemCause?: string
  createdAt: string
  updatedAt: string
}

/** 标签维度组 */
export type TagGroup = 'category' | 'location' | 'custom'

export interface Tag {
  id: string
  name: string
  group: TagGroup
  color: string
  /** 内置标签不可删除 */
  builtin: boolean
}

/** 检查频率 */
export type PlanFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly'

/** 检查计划执行台账 */
export interface PlanExecution {
  id: string
  planId: string
  executor: string
  note: string
  issueIds: string[]
  executedAt: string
}

/** 周期检查计划 */
export interface InspectionPlan {
  id: string
  name: string
  /** 检查范围说明（区域/类型） */
  scope: string
  frequency: PlanFrequency
  /** 下次执行时间 ISO */
  nextRunAt: string
  /** 检查项清单 */
  checklist: string[]
  /** 提前提醒分钟数 */
  remindBeforeMinutes: number
  enabled: boolean
  createdAt: string
  /** 最近一次执行记录（后端 include） */
  executions?: PlanExecution[]
}

/** 参考意义等级：high=需严格注意 | medium=对照自查 | low=一般了解 */
export type RelevanceLevel = 'high' | 'medium' | 'low'

/** 参考件问题标注：评估其他车间问题对成品车间的参考意义（一隐患一条） */
export interface IssueAnnotation {
  id: string
  issueId: string
  relevance: RelevanceLevel
  /** 成品车间的相似点（哪个区域/设备/作业类似） */
  similarity: string
  /** 需要严格注意的事项 */
  caution: string
  /** 标注的隐患类型标签 id（对应 group=category，null 表示未归类） */
  tagId?: string | null
  createdAt: string
  updatedAt: string
}

/** 提醒类型 */
export type ReminderType = 'plan' | 'overdue' | 'review' | 'recheck'

/** 提醒记录 */
export interface Reminder {
  id: string
  type: ReminderType
  /** 关联实体 id（plan 或 issue） */
  refId: string
  title: string
  triggerAt: string
  read: boolean
  done: boolean
}

/** 文档解析出的待确认问题草稿（导入暂存区） */
export interface IssueDraft {
  key: string
  title: string
  description: string
  locationGuess?: string
  categoryGuess?: string
  riskLevel: RiskLevel
  accepted: boolean
  /** 解析推测的发现时间 ISO（确认入库时使用） */
  foundAtGuess?: string
  /** 暂存区人工/猜测匹配后的标签 id */
  categoryId?: string
  locationId?: string
  /** 从通报对应页提取的现场照片（确认入库时上传） */
  photos?: File[]
}

/** 督查通报"复查核销页"解析记录：用于自动闭环库中对应隐患 */
export interface ReviewDraft {
  key: string
  /** 被复查的通报期号（如 "522"） */
  issueNoGuess?: string
  /** 原问题所在车间 */
  workshop?: string
  /** 原问题发现时间 ISO */
  foundAtGuess?: string
  /** 复查时间 ISO（作为核销闭环时间） */
  closedAtGuess?: string
  /** 原问题描述片段（用于模糊匹配库中隐患） */
  snippet: string
  /** 核销结论（如"经查，车间整改核销属实。"） */
  conclusion: string
  accepted: boolean
  /** 前端匹配结果：命中的库中隐患 */
  matchedIssueId?: string
  matchedIssueTitle?: string
  /** 复查页提取的整改后照片（核销确认时追加到命中隐患） */
  photos?: File[]
}
