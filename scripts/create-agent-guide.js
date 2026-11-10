import fs from "node:fs";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImportedXmlComponent,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node create-agent-guide.js /absolute/path/Agent使用指南.docx");

const T = String.raw;
const title = T`Agent 使用指南`;
const palette = {
  dark: "17324D",
  primary: "246B78",
  accent: "D89B45",
  muted: "60717D",
  border: "D8E2E5",
  fill: "EDF4F4",
  warm: "FBF4E9",
  white: "FFFFFF",
};
const font = {
  ascii: "Arial",
  hAnsi: "Arial",
  cs: "Arial",
  eastAsia: "Microsoft YaHei",
};

const run = (text, options = {}) => new TextRun({ text, font, size: 21, color: "263942", ...options });
const para = (children, options = {}) => new Paragraph({
  spacing: { after: 150, line: 320 },
  ...options,
  children: Array.isArray(children) ? children : [children],
});
const body = (text, options = {}) => para(run(text), {
  indent: { firstLine: 420 },
  ...options,
});
const note = (text) => para(run(text, { color: palette.muted, size: 19 }), {
  spacing: { after: 120, line: 290 },
});
const h1 = (text) => para(run(text, { bold: true, size: 30, color: palette.dark }), {
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 120, after: 220 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: palette.primary, space: 8 } },
});
const h2 = (text) => para(run(text, { bold: true, size: 24, color: palette.primary }), {
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 130 },
});
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const spacer = (height = 200) => para(run(""), { spacing: { after: height } });

const cell = (text, width, options = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  margins: { top: 110, bottom: 110, left: 130, right: 130 },
  ...options,
  children: Array.isArray(text)
    ? text.map((line) => para(run(line, options.header ? { bold: true, color: palette.dark } : {}), { spacing: { after: 60, line: 280 } }))
    : [para(run(text, options.header ? { bold: true, color: palette.dark } : {}), { spacing: { after: 0, line: 280 } })],
});
const table = (headers, rows, widths) => new Table({
  width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
  columnWidths: widths,
  rows: [
    new TableRow({
      tableHeader: true,
      children: headers.map((header, index) => cell(header, widths[index], {
        header: true,
        shading: { type: ShadingType.CLEAR, fill: palette.fill },
      })),
    }),
    ...rows.map((row) => new TableRow({
      children: row.map((value, index) => cell(value, widths[index], {
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: palette.border },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: palette.border },
          left: { style: BorderStyle.SINGLE, size: 4, color: palette.border },
          right: { style: BorderStyle.SINGLE, size: 4, color: palette.border },
        },
      })),
    })),
  ],
});
const callout = (heading, text, warm = false) => new Table({
  width: { size: 9000, type: WidthType.DXA },
  columnWidths: [9000],
  rows: [new TableRow({ children: [new TableCell({
    width: { size: 9000, type: WidthType.DXA },
    margins: { top: 170, bottom: 170, left: 190, right: 190 },
    shading: { type: ShadingType.CLEAR, fill: warm ? palette.warm : palette.fill },
    children: [
      para(run(heading, { bold: true, color: warm ? "8A5A18" : palette.primary }), { spacing: { after: 80 } }),
      para(run(text), { spacing: { after: 0, line: 300 } }),
    ],
  })] })],
});

const xmlEscape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const toc = (entries) => {
  const cached = entries.map(({ title: entryTitle, level, page }) => {
    const indent = Math.max(0, level - 1) * 360;
    return `<w:p><w:pPr><w:pStyle w:val="TOC${level}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs><w:ind w:left="${indent}"/></w:pPr><w:r><w:t>${xmlEscape(entryTitle)}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${page}</w:t></w:r></w:p>`;
  }).join("");
  return ImportedXmlComponent.fromXmlString(`<w:sdt xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:sdtPr><w:alias w:val="目录"/></w:sdtPr><w:sdtContent><w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/><w:instrText xml:space="preserve"> TOC \\o &quot;1-3&quot; \\h \\z \\u </w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p>${cached}<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>`).root[0];
};

const entries = [
  { title: "一、快速开始", level: 1, page: 3 },
  { title: "二、四种只读工具", level: 1, page: 4 },
  { title: "三、提问方法与示例", level: 1, page: 5 },
  { title: "四、异步运行、取消与状态", level: 1, page: 6 },
  { title: "五、统计口径与证据验收", level: 1, page: 7 },
  { title: "六、配额、降级与数据安全", level: 1, page: 8 },
  { title: "七、常见问题与管理员检查", level: 1, page: 9 },
  { title: "八、业务边界与责任提示", level: 1, page: 10 },
];

const children = [
  spacer(700),
  para(run("车间安全管理系统", { bold: true, size: 26, color: palette.primary }), { alignment: AlignmentType.CENTER, spacing: { after: 180 } }),
  para(run(title, { bold: true, size: 48, color: palette.dark }), { heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 220 } }),
  para(run("只读查询 · 统一指标 · 证据验收 · 全程留痕", { size: 23, color: palette.muted }), { alignment: AlignmentType.CENTER, spacing: { after: 560 } }),
  table(["项目", "说明"], [
    ["版本", "Agent 只读工具型助手 v2"],
    ["更新日期", "2026-11-09"],
    ["适用角色", "系统管理员、安全管理人员、只读用户（admin / safety_officer / viewer）"],
    ["使用入口", "登录系统后进入“Agent 助手”页面"],
    ["核心原则", "先用只读工具取得事实，再生成回答；未通过证据验收的内容不作为系统结论"],
  ], [2100, 6900]),
  spacer(300),
  callout("先记住这一条", "Agent 只提供查询、统计、检索和分析，不执行隐患新增或修改、闭环、计划、考核等业务写入。实际整改与闭环仍须在对应业务页面按权限办理。", true),
  spacer(250),
  note("本指南依据 2026-11-09 已部署的系统功能编写。页码如因本地 Word/WPS 排版发生变化，请右键目录并选择“更新域”。"),
  pageBreak(),

  para(run("目录", { bold: true, size: 32, color: palette.dark }), { heading: HeadingLevel.HEADING_1, spacing: { after: 220 } }),
  toc(entries),
  spacer(300),
  callout("推荐阅读顺序", "首次使用请先读第一、三、五章；需要解释运行状态时看第四章；遇到失败、限流或登录问题时看第七章；管理员应同时阅读第六、八章。"),
  pageBreak(),

  h1("一、快速开始"),
  h2("1.1 登录与进入"),
  body("使用本人账号登录车间安全管理系统，在导航中打开“Agent 助手”。页面顶部会显示模型配置状态、单次运行限制、每日预算、轨迹保留期限和可用工具。admin、safety_officer、viewer 三种角色均可使用，但只能查看本人创建的运行记录。"),
  callout("升级后需要重新登录", "本次升级加强了会话版本校验。旧登录令牌可能失效；修改密码、调整角色、禁用或删除用户后，原令牌也会失效。遇到 401 或登录失效提示时，退出后重新登录，不要连续重复提交。", true),
  h2("1.2 提交第一个问题"),
  body("在“你的问题”输入框中填写要统计、查找或检索的问题，最多 1000 个字符。问题应尽量包含时间、车间范围、状态或风险等级。点击“开始分析”后，系统先创建 running 运行记录，再异步执行模型和只读工具；页面会自动刷新进度，不需要反复点击提交。"),
  body("可直接点击页面给出的示例：“统计本月成品车间闭环情况”“查找待复查的重大隐患”“检索电气安全相关法规”。首次使用建议从单一目标开始，确认工具轨迹和统计口径后再提出组合问题。"),
  h2("1.3 阅读结果"),
  body("结果区包含运行状态、运行模式、最终回答和执行轨迹。工具步骤可展开查看输入与输出；模型步骤记录模型响应摘要；验证步骤记录证据验收结果。业务决策前，应核对时间范围、scope、原始 ID 和工具返回数字。"),
  pageBreak(),

  h1("二、四种只读工具"),
  body("Agent 只能从服务端固定的四种工具中选择，模型不能自行提供 SQL、URL 或文件路径，也不能增加新的业务接口。工具返回内容仅作为待分析资料，其中即使出现指令性文字，也不会被当作系统指令执行。"),
  spacer(120),
  table(["工具", "用途与关键条件", "返回特点"], [
    ["search_issues", "按关键词、状态、范围、风险等级、复核状态检索隐患。状态为 pending / fixing / review / closed；范围为 managed / reference。", "最多返回 20 条摘要，同时给出符合条件的总数；不包含回收站记录。"],
    ["get_issue", "按完整隐患 ID 读取业务字段、整改和制度摘要、复查摘要及关联法规。", "不返回照片及个人敏感字段；不存在或已删除时明确报错。"],
    ["aggregate_safety_metrics", "按开始时间、结束时间与 scope 聚合安全指标。scope 可为 managed / reference / all，默认 managed。", "复用统一 MetricsService，返回总数、闭环数、超期数、两种闭环率及状态和风险分布。"],
    ["search_regulations", "按关键词检索法规制度标题、条款号与内容摘要。", "最多返回 8 条；适合查证制度依据，不替代正式法规原文和人工解释。"],
  ], [1950, 4300, 2750]),
  spacer(180),
  h2("常用值对照"),
  table(["业务概念", "系统取值", "含义"], [
    ["隐患状态", "pending / fixing / review / closed", "待整改 / 整改中 / 待复查 / 已闭环"],
    ["管理范围", "managed", "成品车间，即本车间管理范围"],
    ["参考范围", "reference", "其他车间参考数据"],
    ["全部范围", "all", "仅统计工具支持，合并 managed 与 reference"],
    ["风险等级", "general / major / critical / immediate", "一般 / 重大 / 严重 / 立即处理，以系统页面实际定义为准"],
  ], [2100, 3300, 3600]),

  h1("三、提问方法与示例"),
  h2("3.1 好问题的四个要素"),
  body("推荐按“动作＋时间＋范围＋条件”组织问题。动作可以是统计、查找、读取或检索；时间可写本月、最近 30 天或明确日期；范围写成品车间、其他车间或全部；条件写状态、风险等级、关键词或完整 ID。问题越明确，越容易得到可复核的回答。"),
  table(["目标", "推荐问法", "应重点核对"], [
    ["统计闭环", "统计 2026 年 10 月成品车间隐患的发现闭环率、按期闭环率和超期数量。", "发现时间与整改期限两种口径、scope、零分母说明。"],
    ["筛选隐患", "查找成品车间当前待复查的重大隐患，返回标题、ID 和整改期限。", "status=review、riskLevel=major、deletedAt 不在结果中。"],
    ["读取详情", "读取隐患 ID（粘贴完整 ID）的复查要求和关联法规。", "ID 是否逐字一致、复查次数与关联依据。"],
    ["检索法规", "检索电气安全相关法规，列出标题、条款号和摘要。", "检索关键词、条款号和更新时间；必要时回到法规页面查原文。"],
    ["跨范围比较", "分别统计本月成品车间和其他车间的闭环情况，并说明口径。", "是否分别使用 managed 与 reference，避免把两次结果混算。"],
  ], [1500, 4500, 3000]),
  h2("3.2 不推荐的方式"),
  body("不要只问“现在怎么样”而不给时间和范围；不要把多个不相关任务塞进一次运行；不要要求 Agent 修改状态、代填闭环证据、制定并下发计划或执行考核。此类写入请求不属于 Agent 能力范围。"),
  body("对同一问题需要重试时，先查看失败或等待人工的原因，再缩短问题、补充筛选条件或改用固定业务页面。连续重复提交不会提高答案可靠性，还可能触发配额限制。"),
  pageBreak(),

  h1("四、异步运行、取消与状态"),
  h2("4.1 异步运行"),
  body("点击“开始分析”后，POST 请求只创建 Agent 自身运行记录并立即返回，实际分析在后台异步执行。页面通过运行 ID 轮询进度，逐步展示真实回答与执行轨迹。创建人只能读取和取消自己的运行，不能读取其他用户的轨迹。"),
  body("运行中可点击“取消运行”。取消会阻止后续模型和工具调度，并将运行置为 cancelled；已产生的轨迹继续保留。服务重启时遗留的 running 会被标记为 failed，需要重新提交，系统不会假装原任务仍在执行。"),
  spacer(120),
  table(["状态", "页面显示", "含义与处理"], [
    ["running", "正在分析", "任务已创建，模型或工具仍在执行。可等待自动刷新，也可取消。"],
    ["succeeded", "已完成", "已形成最终回答，并通过工具证据或确定性降级流程。仍需按业务要求复核。"],
    ["waiting_human", "等待人工", "未取得工具证据、数字或 ID 未通过验收，或已耗尽步骤／模型／时间预算。该回答不作为系统结论。"],
    ["failed", "运行失败", "模型接口、工具、服务重启或其他异常导致失败。查看 error 与验证轨迹，稍后重试或联系管理员。"],
    ["cancelled", "已取消", "创建人主动终止。未修改任何业务数据，可调整后重新提问。"],
  ], [1700, 1700, 5600]),
  spacer(180),
  callout("运行模式不等于运行状态", "Agent 模式表示配置了模型并进行工具协作；Fallback 模式表示模型未配置，由固定规则选择一个只读工具并生成确定性答案。两种模式都可能成功，也都必须结合工具和口径阅读。"),
  pageBreak(),

  h1("五、统计口径与证据验收"),
  h2("5.1 两种闭环率不能混用"),
  table(["指标", "计算口径", "解读注意"], [
    ["发现闭环率 discoveredClosureRate", "统计范围内，按发现时间 foundAt 筛选的隐患中，已闭环数 ÷ 隐患总数 × 100%。", "回答“本期发现的隐患目前闭环了多少”。未闭环且当前时间已超过整改期限的计入超期数。"],
    ["按期闭环率 dueClosureRate", "统计范围内，按整改期限 deadline 筛选的隐患中，closedAt 不晚于 deadline 的数量 ÷ 有整改期限的隐患总数 × 100%。", "回答“本期到期的任务有多少按期闭环”。闭环时间晚于期限不算按期闭环。"],
  ], [2300, 4100, 2600]),
  body("两个页面字段均以 0～100 的百分数返回。分母为 0 时返回 null，表示“无统计基数”，不能解释为 0%，也不能解释为 100%。统计接口开始和结束边界均包含；Agent 旧字段 closureRate 为兼容原契约仍使用 0～1，代表已闭环数 ÷ 总发现数。"),
  body("范围方面，managed 表示成品车间，reference 表示其他车间，all 表示全部；省略 scope 时默认 managed。统计排除回收站记录和标记为正面案例的记录。提问和引用时必须写清统计周期、范围与指标名称。"),
  h2("5.2 确定性证据验收"),
  body("模型回答前必须至少成功调用一个只读工具。统计问题必须调用 aggregate_safety_metrics；回答中的统计数字必须能在成功工具结果中找到，引用的隐患或法规 ID 必须与工具返回逐字一致。系统还会检查证据步骤并保存验证轨迹。"),
  callout("未通过验收时的正确做法", "出现 waiting_human 时，不要把模型草稿当成正式统计结果。请打开工具与验证轨迹核对原因，改用统计、隐患或法规固定页面查询，或交人工复核。", true),
  pageBreak(),

  h1("六、配额、降级与数据安全"),
  h2("6.1 运行预算"),
  table(["限制项", "当前值", "说明"], [
    ["单用户频率", "10 次／分钟", "超过后提示当前用户请求过于频繁，请一分钟后重试。"],
    ["全局频率", "30 次／分钟", "所有用户合计；用于保护数据库与模型服务。"],
    ["全局日预算", "200 次／自然日", "达到后当天不再创建新运行，次日再试。"],
    ["单次步骤", "最多 6 步", "模型、工具等执行步骤共享此上限。"],
    ["模型调用", "单次最多 3 次", "防止无效循环与不可控消耗。"],
    ["总时限", "45 秒", "单次模型调用还受 25 秒、单次工具受 5 秒及剩余总时限约束。"],
    ["轨迹保留", "90 天", "服务启动时清理过期运行及级联步骤，超出后不再提供历史轨迹。"],
  ], [2400, 1900, 4700]),
  h2("6.2 模型未配置时的 Fallback"),
  body("未配置模型 API Key 时，页面明确显示“模型未配置，使用规则降级”。系统根据关键词选择一种只读工具：统计类进入统一聚合，法规类进入制度检索，完整 ID 进入详情读取，其余进入隐患检索。回答由固定模板生成，不声称经过大模型推理。"),
  body("Fallback 适合明确、单一的问题，不理解复杂语义，也不会自动完成多步比较。复杂任务请由管理员配置兼容 chat/completions 的模型服务，或拆成多次明确查询。"),
  h2("6.3 密钥与会话安全"),
  body("管理员新保存的模型 Key 使用 AES-256-GCM 加密，系统兼容读取历史明文配置。部署环境必须持久化 SETTINGS_ENCRYPTION_KEY，并限制备份和环境变量访问权限；不要在提问、截图、日志或本文档中粘贴真实 Key。生产 JWT_SECRET 至少 32 个字符且不能使用默认值。"),
  pageBreak(),

  h1("七、常见问题与管理员检查"),
  table(["现象", "可能原因", "建议处理"], [
    ["401、登录失效或跳回登录页", "升级后旧令牌失效；密码、角色或账号状态发生变化。", "退出并重新登录；仍失败时联系管理员核对账号状态，不要重复提交运行。"],
    ["提示请求过于频繁或日预算用尽", "达到 10 次／用户／分钟、30 次／全局／分钟或 200 次／日。", "按提示等待；日预算用尽则次日再试。优先使用固定页面做重复查询。"],
    ["一直显示正在分析", "模型或工具响应缓慢，或页面刷新暂时失败。", "等待自动轮询，检查页面错误提示；必要时取消。单次总时限为 45 秒。"],
    ["等待人工", "没有成功工具证据、数字或 ID 验收失败，或预算耗尽。", "查看验证轨迹，缩小问题并明确口径；重要结论到固定业务页面复核。"],
    ["运行失败", "模型接口错误、返回为空、工具异常或服务重启。", "保留运行 ID 和时间，查看 error；管理员检查模型地址、网络、密钥和后端日志。"],
    ["模型未配置", "未保存有效模型 API Key，或配置不可读取。", "可使用 Fallback；需要完整 Agent 时由管理员在知识库／模型配置中检查设置。"],
    ["查不到隐患或法规", "关键词过长、条件过窄、范围不对，或记录已删除。", "缩短关键词，逐项减少筛选条件，确认 managed / reference / all 与状态。"],
    ["统计数字与预想不同", "混用了发现闭环率与按期闭环率，或时间边界、范围、正面案例口径不同。", "先核对 generatedAt、period、scope、分母及 null，再比较数字。"],
  ], [2050, 3300, 3650]),
  spacer(180),
  h2("管理员排障顺序"),
  body("先确认后端健康与登录状态，再看 Agent 能力和运行轨迹；随后检查模型服务、配额和统一统计口径。不要把业务数据异常与 Agent 表达异常混为一谈：前者到固定业务页面和数据库核验，后者查看模型、工具及验证步骤。真实密钥不应写入工单或聊天记录。"),
  pageBreak(),

  h1("八、业务边界与责任提示"),
  callout("Agent 不执行业务写入", "Agent 不新增、编辑或删除隐患，不推进状态或阶段，不上传或修改闭环证据，不执行闭环、计划或考核写入。POST /agent/runs 仅创建 Agent 自身的运行轨迹，不修改上述业务表。", true),
  h2("8.1 正确的业务办理方式"),
  body("隐患整改、复查、闭环、证据更正、制度沉淀、计划执行和考核仍由有权限的人员在对应业务页面操作。闭环和证据更正的幂等、并发、审计与 Outbox 机制属于业务后端保障，不应由 Agent 绕过。回收站记录也不会进入 Agent 的普通查询。"),
  h2("8.2 回答的使用边界"),
  body("Agent 输出是基于当前数据库与已配置法规资料的辅助分析，不替代现场核查、正式法规原文、专业判断和审批。涉及重大风险、人身伤害、停工、处罚或对外报送时，必须以原始业务记录和人工复核为准。"),
  h2("8.3 最小复核清单"),
  table(["复核项", "确认内容"], [
    ["运行状态", "是否为 succeeded；waiting_human、failed、cancelled 不作为正式结论。"],
    ["统计口径", "时间、范围、发现／到期口径、百分数尺度与零分母是否明确。"],
    ["证据", "工具是否成功，数字和引用 ID 是否与工具输出一致，验证步骤是否通过。"],
    ["业务动作", "需要整改、闭环、计划或考核时，是否已转到相应业务页面由人员办理。"],
    ["信息安全", "是否避免在问题与截图中泄露模型 Key、令牌、个人敏感信息或不应公开的资料。"],
  ], [2300, 6700]),
  spacer(300),
  para(run("—— 文档结束 ——", { color: palette.muted, size: 19 }), { alignment: AlignmentType.CENTER, spacing: { before: 300 } }),
];

const doc = new Document({
  creator: "车间安全管理系统",
  title: "Agent 使用指南",
  description: "车间安全管理系统只读 Agent 使用、安全边界与故障排查指南",
  features: { updateFields: true },
  styles: {
    paragraphStyles: [{
      id: "TOC1",
      name: "TOC 1",
      basedOn: "Normal",
      next: "Normal",
      run: { font, size: 21, color: "263942" },
      paragraph: { spacing: { after: 110, line: 290 } },
    }],
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1150, right: 1150, bottom: 1150, left: 1150, header: 600, footer: 600 },
      },
    },
    headers: {
      default: new Header({ children: [para(run("车间安全管理系统  |  Agent 使用指南", { size: 17, color: palette.muted }), {
        alignment: AlignmentType.RIGHT,
        spacing: { after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: palette.border, space: 4 } },
      })] }),
    },
    footers: {
      default: new Footer({ children: [para(new TextRun({ children: [PageNumber.CURRENT], font, size: 18, color: palette.muted }), {
        alignment: AlignmentType.CENTER,
        spacing: { after: 0 },
      })] }),
    },
    children,
  }],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
