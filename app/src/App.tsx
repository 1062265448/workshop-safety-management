import { useState } from 'react'
import { Route, Routes } from 'react-router'
import Layout from './components/Layout'
import { StoreProvider } from './lib/store'
import Annotations from './pages/Annotations'
import Dashboard from './pages/Dashboard'
import IssueEntry from './pages/IssueEntry'
import IssueList from './pages/IssueList'
import Login from './pages/Login'
import Plans from './pages/Plans'
import Statistics from './pages/Statistics'
import TagManager from './pages/TagManager'

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('wsms-token'))

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
        </Route>
      </Routes>
    </StoreProvider>
  )
}
