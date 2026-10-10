import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, BookOpen } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// 使用手册（应用内帮助页）：快速上手 · 各功能说明 · 角色权限 · 常见问题
// ─────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'quickstart',
    title: '三分钟上手',
    body: (
      <ol className="space-y-2.5">
        {[
          ['登记问题', '「问题录入」手动填写，或把厂督察通报 PPT 拖进文件导入——机器先识别，你逐条勾选确认后才入库。'],
          ['推进整改', '问题库里每条隐患右侧的蓝色按钮就是"下一步"：待整改 → 整改中 → 待复查 → 已闭环，确认闭环自动记录时间。'],
          ['防复发复查', '闭环不是终点：成品车间隐患默认还要做 3 次复查（每 7 天一次），到点提醒中心自动出现复查提醒。'],
          ['看统计定方向', '「周期统计」看类型/区域分布和按期闭环率；切换到"其他车间"视角，能看到厂督察最近在重点查什么。'],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="w-5 h-5 rounded-full bg-[#007AFF]/10 text-[#007AFF] text-[12px] font-medium flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
            <div>
              <span className="text-[14px] font-medium">{t}</span>
              <p className="text-[13px] text-neutral-500 mt-0.5">{d}</p>
            </div>
          </li>
        ))}
      </ol>
    ),
  },
  {
    id: 'boundary',
    title: '重要边界：成品车间 vs 其他车间',
    body: (
      <div className="space-y-2 text-[13px] text-neutral-600 leading-relaxed">
        <p>本系统只管<strong className="text-neutral-900">成品车间</strong>的闭环整改：超期提醒、防复发复查、闭环率统计都只围绕它。</p>
        <p>厂督察通报里<strong className="text-neutral-900">其他车间</strong>的问题导入时自动标为"参考"：只存档、不进闭环、不产生提醒，但可以在统计页单独查看——用来观察厂督察近期的检查重点，给成品车间对照自查。</p>
      </div>
    ),
  },
  {
    id: 'pages',
    title: '各功能页说明',
    body: (
      <dl className="space-y-3.5">
        {[
          ['总览（首页）', '回答"现在最该干什么"：待整改/超期/闭环率数字卡，最新隐患与待处理提醒。数字只统计成品车间。'],
          ['问题录入', '两条路：手动录入（日常巡检，可附现场照片）或文件导入（厂督察通报 PPT / Word / Excel）。文件只在本机浏览器解析，确认后才入库；通报照片自动提取。'],
          ['问题库', '全部隐患总账。点标题弹详情层：看时间线、照片，直接编辑任何字段；卡片蓝按钮推进整改四步；虚线小方块随时补传整改后照片。'],
          ['参考标注', '把其他车间参考件逐条评估对成品车间的参考意义（需严格注意 / 对照自查 / 一般了解），新通报导入后从这里清账。'],
          ['标签管理', '隐患类型、区域、自定义三组标签。内置标签不可删；重名会被拦下；删除标签自动解除隐患引用。'],
          ['周期统计', '近 7/30/90 天的新增与闭环趋势、类型分布、区域分布、按期闭环率。范围可切成"其他车间"看厂督察风向。'],
          ['检查计划', '周期性检查任务：到点进提醒中心，"完成本次检查"自动记台账并推进下一周期。'],
          ['提醒中心', '检查到点、整改超期、待复查、防复发复查四类提醒，每分钟自动刷新。'],
          ['用户管理（仅管理员）', '新建账号、分配角色（管理员/安全员/查看者）、重置密码、删除账号。系统始终保留至少一名管理员。'],
        ].map(([t, d]) => (
          <div key={t}>
            <dt className="text-[14px] font-medium">{t}</dt>
            <dd className="text-[13px] text-neutral-500 mt-0.5 leading-relaxed">{d}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: 'roles',
    title: '角色与权限',
    body: (
      <ul className="space-y-2 text-[13px] text-neutral-600">
        {[
          ['管理员', '全部功能 + 用户管理', 'bg-[#007AFF]/10 text-[#007AFF]'],
          ['安全员', '录入、导入、整改闭环、标注、计划等全部业务操作', 'bg-[#FF9500]/10 text-[#C93400]'],
          ['查看者', '仅可浏览（后端强制，任何修改操作都会被拒绝）', 'bg-neutral-100 text-neutral-500'],
        ].map(([role, desc, cls]) => (
          <li key={role} className="flex items-center gap-2.5">
            <span className={`px-1.5 py-0.5 rounded-md text-[11px] shrink-0 ${cls}`}>{role}</span>
            <span>{desc}</span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'faq',
    title: '常见问题',
    body: (
      <dl className="space-y-3">
        {[
          ['点了按钮没反应？', '看页面顶部有没有红色提示条"后端服务不可达"——有则联系管理员重启服务（双击 重启服务.bat）。'],
          ['通报里某条问题没被识别？', '导入暂存区顶部橙色「N 页未识别」折叠区逐页列出跳过原因和预览；漏掉的条目手动录入补上，通报发给管理员调解析规则。'],
          ['照片不显示（裂图）？', '强制刷新页面（Ctrl+F5；手机端关掉重开）。'],
          ['导入重复了怎么办？', '系统不自动去重：暂存区确认前取消勾选重复条目；已入库的在问题库里两段式确认删除。'],
          ['整改期限怎么定？', '导入时按风险等级自动设定：重大 3 天、较大 7 天、一般 15 天（仅成品车间）；手动录入时自行选择。'],
          ['删除隐患后照片还在吗？', '在。照片文件保留在服务器 uploads 目录，删除隐患不会清理照片文件。'],
          ['手机上怎么用？', '浏览器打开同一地址（外网用 https://wsms.jcngcp.xyz），菜单选"添加到主屏幕"即可像 App 一样全屏使用，现场排查可直接拍照录入。'],
        ].map(([q, a]) => (
          <div key={q}>
            <dt className="text-[14px] font-medium">Q：{q}</dt>
            <dd className="text-[13px] text-neutral-500 mt-0.5 leading-relaxed">{a}</dd>
          </div>
        ))}
      </dl>
    ),
  },
]

export default function Help() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash])

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Link to="/" className="inline-flex items-center gap-1 text-[13px] text-[#007AFF] mb-2">
          <ArrowLeft className="w-3.5 h-3.5" /> 返回总览
        </Link>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-[#007AFF]" strokeWidth={2} />
          使用手册
        </h1>
        <p className="text-sm text-neutral-500 mt-1">面向车间安全员与管理员 · 完整流程说明见项目内《使用手册.md》</p>
        <nav className="flex flex-wrap gap-2 mt-3">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="px-3 py-1.5 rounded-full bg-white text-[13px] text-[#007AFF] shadow-sm hover:bg-[#007AFF]/5 transition-colors">
              {s.title}
            </a>
          ))}
        </nav>
      </header>

      {SECTIONS.map((s) => (
        <section key={s.id} id={s.id} className="bg-white rounded-2xl p-5 shadow-sm scroll-mt-4">
          <h2 className="text-[15px] font-semibold mb-3">{s.title}</h2>
          {s.body}
        </section>
      ))}
    </div>
  )
}
