import { Suspense, lazy, useState } from 'react'
import { Route, Routes, Navigate } from 'react-router'
import Layout from './components/Layout'
import { StoreProvider } from './lib/store'
import { getCurrentUser } from './lib/auth'
import Login from './pages/Login'
// 路由级懒加载：首屏只下载登录+总览所需代码，其余页面（统计图表库等大依赖）按需拆分加载
const Dashboard = lazy(() => import('./pages/Dashboard'))
const IssueEntry = lazy(() => import('./pages/IssueEntry'))
const IssueList = lazy(() => import('./pages/IssueList'))
const Annotations = lazy(() => import('./pages/Annotations'))
const TagManager = lazy(() => import('./pages/TagManager'))
const Statistics = lazy(() => import('./pages/Statistics'))
const Plans = lazy(() => import('./pages/Plans'))
const Users = lazy(() => import('./pages/Users'))

function PageLoading() {
  return (
    <div className="flex items-center justify-center py-24 text-[13px] text-neutral-400">
      页面加载中…
    </div>
  )
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('wsms-token'))
  const isAdmin = getCurrentUser()?.role === 'admin'

  if (!token) {
    return <Login onLogin={setToken} />
  }

  return (
    <StoreProvider>
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/entry" element={<IssueEntry />} />
            <Route path="/issues" element={<IssueList />} />
            <Route path="/annotations" element={<Annotations />} />
            <Route path="/tags" element={<TagManager />} />
            <Route path="/stats" element={<Statistics />} />
            <Route path="/plans" element={<Plans />} />
            {/* 用户管理仅管理员可见；其余角色访问时回到总览（后端仍做双重校验） */}
            <Route path="/users" element={isAdmin ? <Users /> : <Navigate to="/" replace />} />
            {/* 未知路径（含已删除的 /help 旧书签）回总览 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </StoreProvider>
  )
}
