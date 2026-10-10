import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import {
  LayoutDashboard, FilePlus2, ClipboardList, Flag, Tags, BarChart3, CalendarClock, Bell, ShieldCheck, LogOut, Menu, X, Users, BookOpen,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { getCurrentUser, logout } from '@/lib/auth'
import ChangePassword from './ChangePassword'

const NAV = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/entry', label: '问题录入', icon: FilePlus2 },
  { to: '/issues', label: '问题库', icon: ClipboardList },
  { to: '/annotations', label: '参考标注', icon: Flag },
  { to: '/tags', label: '标签管理', icon: Tags },
  { to: '/stats', label: '周期统计', icon: BarChart3 },
  { to: '/plans', label: '检查计划', icon: CalendarClock },
]

export default function Layout() {
  const { reminders, offline } = useStore()
  const unread = reminders.filter((r) => !r.read && !r.done).length
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isAdmin = getCurrentUser()?.role === 'admin'

  const navItems = (onNavigate?: () => void) => (
    <>
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] transition-colors',
              isActive ? 'bg-[#007AFF]/10 text-[#007AFF] font-medium' : 'text-neutral-600 hover:bg-neutral-100',
            )
          }
        >
          <Icon className="w-4 h-4" strokeWidth={2} />
          {label}
        </NavLink>
      ))}
      {isAdmin && (
        <NavLink
          to="/users"
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] transition-colors',
              isActive ? 'bg-[#007AFF]/10 text-[#007AFF] font-medium' : 'text-neutral-600 hover:bg-neutral-100',
            )
          }
        >
          <Users className="w-4 h-4" strokeWidth={2} />
          用户管理
        </NavLink>
      )}
      <NavLink
        to="/help"
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] transition-colors',
            isActive ? 'bg-[#007AFF]/10 text-[#007AFF] font-medium' : 'text-neutral-600 hover:bg-neutral-100',
          )
        }
      >
        <BookOpen className="w-4 h-4" strokeWidth={2} />
        使用手册
      </NavLink>
    </>
  )

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-neutral-900" style={{ fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif' }}>
      {/* 移动端顶栏 */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 h-14 bg-white/85 backdrop-blur border-b border-neutral-200/70 flex items-center gap-3 px-4">
        <button onClick={() => setDrawerOpen(true)} className="p-1.5 -ml-1 text-neutral-600">
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#007AFF] flex items-center justify-center">
            <ShieldCheck className="w-4 h-4 text-white" strokeWidth={2.2} />
          </div>
          <span className="text-[15px] font-semibold">车间安全管理</span>
        </div>
        <NavLink to="/plans" className="ml-auto relative p-1.5 text-neutral-600">
          <Bell className="w-5 h-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4.5 h-4.5 px-1 rounded-full bg-[#FF3B30] text-white text-[10px] flex items-center justify-center">
              {unread}
            </span>
          )}
        </NavLink>
      </header>

      {/* 移动端抽屉导航 */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="absolute inset-y-0 left-0 w-64 bg-white flex flex-col p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[15px] font-semibold">导航</span>
              <button onClick={() => setDrawerOpen(false)} className="p-1 text-neutral-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1">{navItems(() => setDrawerOpen(false))}</nav>
            {/* 抽屉底部：提醒 / 改密 / 退出（与桌面侧边栏对齐） */}
            <div className="pt-3 mt-3 border-t border-neutral-100 space-y-1">
              <NavLink
                to="/plans"
                onClick={() => setDrawerOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] text-neutral-600 hover:bg-neutral-100"
              >
                <Bell className="w-4 h-4" strokeWidth={2} />
                提醒中心
                {unread > 0 && (
                  <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-[#FF3B30] text-white text-[11px] flex items-center justify-center">
                    {unread}
                  </span>
                )}
              </NavLink>
              <ChangePassword className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors" />
              <button
                onClick={logout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors"
              >
                <LogOut className="w-4 h-4" strokeWidth={2} />
                退出登录
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 桌面端侧边导航 */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-56 bg-white/80 backdrop-blur border-r border-neutral-200/70 flex-col">
        <div className="flex items-center gap-2.5 px-5 h-16">
          <div className="w-8 h-8 rounded-lg bg-[#007AFF] flex items-center justify-center">
            <ShieldCheck className="w-4.5 h-4.5 text-white" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight">车间安全管理</div>
            <div className="text-[11px] text-neutral-400 leading-tight">隐患排查治理闭环</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-2 space-y-1">{navItems()}</nav>
        <NavLink
          to="/plans"
          className="mx-3 mb-1 flex items-center gap-2.5 px-3 py-2 rounded-lg text-[14px] text-neutral-600 hover:bg-neutral-100"
        >
          <Bell className="w-4 h-4" strokeWidth={2} />
          提醒中心
          {unread > 0 && (
            <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-[#FF3B30] text-white text-[11px] flex items-center justify-center">
              {unread}
            </span>
          )}
        </NavLink>
        <ChangePassword />
        <button
          onClick={logout}
          className="mx-3 mb-4 flex items-center gap-2.5 px-3 py-2 rounded-lg text-[14px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors"
        >
          <LogOut className="w-4 h-4" strokeWidth={2} />
          退出登录
        </button>
      </aside>

      {/* 主内容 */}
      <main className="lg:ml-56 p-4 pt-[72px] lg:p-8">
        {offline && (
          <div className="max-w-5xl mb-4 px-4 py-2.5 rounded-xl bg-[#FF3B30]/10 text-[#D70015] text-[13px]">
            后端服务不可达。请联系管理员启动服务。
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
