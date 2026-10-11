import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, BookOpen } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// 使用手册（应用内帮助页）：快速上手 · 各功能说明 · 角色权限 · 常见问题
// ─────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'quickstart',
    title: '上手就这么四步',
    body: (
      <ol className="space-y-2.5">
        {[
          ['登记', '「问题录入」手动填，或者把厂督察通报 PPT 传上去。系统先识别，你逐条勾选、确认后才入库。'],
          ['整改', '问题库里每条隐患右边有个蓝色按钮，点它就是"下一步"：待整改 → 整改中 → 待复查 → 已闭环。闭环时间自动记上。'],
          ['复查', '成品车间的隐患闭环后还要复查 3 次，每 7 天一次。到期「提醒中心」会出现提醒，做完记得点掉。'],
          ['看统计', '「周期统计」能看哪类问题多、哪个区域多、有没有按期改完。切到"其他车间"，能看到厂督察最近在查什么，咱们好对照自查。'],
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
    title: '先弄清一件事：成品车间 vs 其他车间',
    body: (
      <div className="space-y-2 text-[13px] text-neutral-600 leading-relaxed">
        <p>这个系统只管<strong className="text-neutral-900">成品车间</strong>的整改：超期提醒、复查、闭环率，都只算成品车间。</p>
        <p>通报里<strong className="text-neutral-900">其他车间</strong>的问题，导入时自动标成"参考"——存档，但不进闭环、不催办。想看厂督察最近在重点查哪里，到统计页切到"其他车间"就能看。</p>
      </div>
    ),
  },
  {
    id: 'pages',
    title: '每个页面是干什么的',
    body: (
      <dl className="space-y-3.5">
        {[
          ['总览（首页）', '打开先看这页：待整改几条、超期几条、闭环率多少，下面是最新的隐患和要处理的提醒。数字只算成品车间。'],
          ['问题录入', '两条路子：手动录（日常巡检用，能带现场照片）；文件导入（厂督察通报 PPT / Word / Excel）。文件在你自己电脑的浏览器里解析，确认后才入库，通报里的照片自动提出来。'],
          ['问题库', '所有隐患的总账。点标题看详情：时间线、照片都能看，字段直接改。卡片上的蓝按钮推进整改；虚线小方块用来补传整改后的照片。'],
          ['参考标注', '通报里其他车间的问题，逐条评估对咱们有没有用（需严格注意 / 对照自查 / 一般了解）。新通报导进来后，到这里一条条过完。'],
          ['标签管理', '类型、区域、自定义三组标签。内置的删不掉；名字重了会拦下来；删标签不影响隐患，只是自动摘掉这个标签。'],
          ['周期统计', '近 7 / 30 / 90 天的新增、闭环、类型分布、区域分布、按期闭环率。也能切到"其他车间"看厂督察的检查重点。'],
          ['检查计划', '定周期性的检查任务。到点「提醒中心」会叫你；点"完成本次检查"，自动记一笔台账，顺便排好下一次。'],
          ['提醒中心', '检查到点、整改超期、待复查、防复发复查四类提醒，每分钟自己刷新。'],
          ['用户管理（仅管理员）', '开账号、定角色（管理员 / 安全员 / 只读）、重置密码、删账号。注意至少留一个管理员。'],
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
    title: '谁能干什么',
    body: (
      <ul className="space-y-2 text-[13px] text-neutral-600">
        {[
          ['管理员', '什么都能干，包括管账号', 'bg-[#007AFF]/10 text-[#007AFF]'],
          ['安全员', '业务都能操作：录入、导入、整改、复查、计划', 'bg-[#FF9500]/10 text-[#C93400]'],
          ['只读', '只能看。想改也不行，后端会直接拒掉', 'bg-neutral-100 text-neutral-500'],
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
          ['点了按钮没反应？', '先看页面顶部有没有红色提示条"后端服务不可达"。有的话喊管理员重启（双击 重启服务.bat）。'],
          ['通报里有的问题没识别出来？', '暂存区最上面有橙色「N 页未识别」折叠区，哪页跳了、内容是什么都列着。漏掉的补手动录入，这份通报转给管理员调识别规则。'],
          ['照片裂了？', '强制刷新（Ctrl + F5）；手机端把页面关掉重开。'],
          ['导重了怎么办？', '系统不会去重。暂存区确认时把重复的勾掉；已经入库的到问题库删掉（要确认两次）。'],
          ['整改期限怎么定的？', '导入时按风险等级自动定：重大 3 天、较大 7 天、一般 15 天（只有成品车间算）；手动录的时候自己选。'],
          ['隐患删了，照片还在吗？', '在。照片留在服务器 uploads 文件夹里，删隐患不动照片。'],
          ['手机上怎么用？', '浏览器开同一个地址（在外面就用 https://wsms.jcngcp.xyz），菜单里选"添加到主屏幕"，以后点图标就能用，现场拍完照直接录。'],
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
        <p className="text-sm text-neutral-500 mt-1">写给安全员和管理员 · 项目里另有一份更详细的《使用手册.md》</p>
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
