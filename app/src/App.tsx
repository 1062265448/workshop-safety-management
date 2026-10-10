import { useState } from 'react'
import { Route, Routes, Navigate } from 'react-router'
import Layout from './components/Layout'
import { StoreProvider } from './lib/store'
import { getCurrentUser } from './lib/auth'
import Annotations from './pages/Annotations'
import Dashboard from './pages/Dashboard'
import IssueEntry from './pages/IssueEntry'
import IssueList from './pages/IssueList'
import Login from './pages/Login'
import Plans from './pages/Plans'
import Statistics from './pages/Statistics'
import TagManager from './pages/TagManager'
import Users from './pages/Users'
import Help from './pages/Help'

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('wsms-token'))
  const isAdmin = getCurrentUser()?.role === 'admin'

  if (!token) {
    return <Login onLogin={setToken} />
  }

  return (
    <StoreProvider>
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
          <Route path="/help" element={<Help />} />
        </Route>
      </Routes>
    </StoreProvider>
  )
}
