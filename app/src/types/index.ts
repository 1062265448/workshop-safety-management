// ─────────────────────────────────────────────────────────────
// 车间安全管理系统 · 核心数据模型
// ─────────────────────────────────────────────────────────────

/** 风险等级（枚举字段，决定默认整改时限） */
export type RiskLevel = 'general' | 'critical' | 'immediate'

/** 隐患状态机：待整改 → 整改中 → 待复查 → 已闭环；逾期由 deadline 推导 */
export type IssueStatus = 'pending' | 'fixing' | 'review' | 'closed'

/** 录入来源 */
export type IssueSource = 'manual' | 'pptx' | 'docx' | 'xlsx'

/** 管理范围：managed=成品车间（完整闭环），reference=其他车间（仅参考） */
export type IssueScope = 'managed' | 'reference'

/** 戴明 94/6 根因类别：system=系统原因 | individual=个人原因 */
export type CauseType = 'system' | 'individual'

/** 对策层级（仅系统原因时有意义）：机制 → 技术 → 管理 */
export type CountermeasureLevel = 'mechanism' | 'technical' | 'management'

/** 整改闭环阶段：复查中 → 制度沉淀 → 教育职工 → 规范执行 → 闭环完成 */
export type IssueStage = 'rechecking' | 'institutionalizing' | 'educating' | 'executing' | 'done'

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
  /** 戴明 94/6 根因类别（null/undefined=未判定） */
  causeType?: CauseType | null
  /** 对策层级（仅 causeType=system 时有意义） */
  countermeasureLevel?: CountermeasureLevel | null
  /** 选 management 时必填：为什么机制和技术做不到 */
  countermeasureReason?: string | null
  /** 整改闭环阶段（默认 rechecking，三次复查全合格后进入制度沉淀） */
  stage: IssueStage
  /** 制度沉淀记录（制度要点） */
  institutionNote?: string | null
  /** 制度沉淀关联的知识库条目 id */
  linkedKnowledgeDocId?: string | null
  /** 回收站：删除时间 ISO（有值表示已删除，可恢复） */
  deletedAt?: string | null
  /** 人工复核标记：手动录入为 true；AI 批量识别入库为 false，复核后改 true */
  reviewed?: boolean
  /** AI 预标注（只预判，不覆盖人工字段）：建议的隐患类型名（含子标签「父-子」） */
  aiCategory?: string | null
  /** AI 建议风险等级 */
  aiRiskLevel?: RiskLevel | null
  /** AI 建议根因类别 */
  aiCauseType?: CauseType | null
  /** AI 整改建议（一句话） */
  aiSuggestion?: string | null
  /** 正面典型（做得好）：不计入整改闭环/超期提醒，自动沉淀知识库「好做法」 */
  isGood?: boolean
  /** isGood=true 时自动创建的知识库「好做法」文档 id */
  linkedGoodDocId?: string | null
  /** 关联的法规依据（后端 include 拍平） */
  regulations?: Regulation[]
  createdAt: string
  updatedAt: string
}

/** 法规分类：国家法律 / 行政法规 / 国家标准 / 集团制度 / 厂级制度 */
export type RegulationCategory = 'national_law' | 'regulation' | 'gb_standard' | 'group_policy' | 'factory_policy'

/** 法规制度库条目 */
export interface Regulation {
  id: string
  category: RegulationCategory
  title: string
  /** 条款号（可空） */
  articleNo?: string | null
  /** 内容摘要 */
  summary: string
  createdAt: string
  updatedAt: string
}

/** 知识库文档列表项 */
export interface KnowledgeDocItem {
  id: string
  kind: string
  refId?: string | null
  title: string
  source: string
  createdAt: string
  chunks: number
  versions: number
}

/** 知识库文档详情（正文 = 切片拼接） */
export interface KnowledgeDocDetail {
  id: string
  kind: string
  refId?: string | null
  title: string
  source: string
  createdAt: string
  content: string
}

/** 知识库文档历史版本（列表项，不含正文） */
export interface KnowledgeDocVersionItem {
  id: string
  version: number
  title: string
  note: string
  createdAt: string
}

/** 知识库文档历史版本详情（含正文快照） */
export interface KnowledgeDocVersionDetail extends KnowledgeDocVersionItem {
  docId: string
  content: string
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
  /** 子标签：父标签 id（仅 category 组使用） */
  parentId?: string | null
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

/** 考核台账记录：网格责任人重复达到阈值时自动写入 */
export interface Assessment {
  id: string
  /** 触发的隐患 id（无外键，隐患删除后记录保留） */
  issueId?: string | null
  issueTitle: string
  /** 被考核人（网格责任人或整改责任人） */
  owner: string
  /** normal=提醒 | double=加倍考核 */
  level: 'normal' | 'double'
  /** 考核周期起止 ISO（当月10日 06:00 ~ 次月10日 06:00） */
  periodStart: string
  periodEnd: string
  note: string
  createdAt: string
}

/** 知识库条目下拉选项（制度沉淀关联用） */
export interface KnowledgeDocOption {
  id: string
  title: string
  kind: string
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
  /** 批量导入时来源文件名（用于按文件归类与入库 sourceFile） */
  fileName?: string
  /** AI 预标注结果（暂存区行内展示 + 入库时写入 ai* 字段） */
  ai?: PrelabelSuggestion
  /** 采用 AI 建议后回填的根因类别（随入库提交人工字段） */
  causeType?: CauseType
  countermeasureLevel?: CountermeasureLevel
}

/** AI 预标注单条结果：skipped=文本过短未送 AI；error=该条失败（不中断整批） */
export interface PrelabelSuggestion {
  categoryName?: string | null
  riskLevel?: RiskLevel | null
  causeType?: CauseType | null
  countermeasureLevel?: CountermeasureLevel | null
  suggestion?: string | null
  skipped?: 'too_short'
  error?: string
}

/** AI 预标注范例（已复核且已分类的隐患，供提示词对齐口径） */
export interface PrelabelExample {
  id: string
  categoryName: string
  title: string
  description: string
  createdAt: string
}

/** 人工改动率：改动率高说明 AI 口径与人工偏差大，可多设范例 */
export interface PrelabelStats {
  total: number
  changed: number
  rate: number
}

/** 文字规范检查结果（四要素检查 + 模糊词拦截；skipped=文本过短未送 AI） */
export interface StyleCheckResult {
  ok?: boolean
  problems?: string[]
  rewrite?: string
  skipped?: 'too_short'
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
  /** 批量导入时来源文件名 */
  fileName?: string
}
