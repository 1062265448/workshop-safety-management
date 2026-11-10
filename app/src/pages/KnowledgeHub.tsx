import { useState, type KeyboardEvent } from 'react'
import { BookMarked, BookOpen, Bot, FileText, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import Agent from './Agent'
import Knowledge, { type KnowledgeView } from './Knowledge'
import ModelSettings from '@/components/ModelSettings'
import { getCurrentUser } from '@/lib/auth'

const TABS = [
  { id: 'agent', label: 'Agent 检索', description: '统计业务数据并综合分析', icon: Bot },
  { id: 'search', label: '资料检索', description: '查找知识原文与相似案例', icon: Search },
  { id: 'regs', label: '法规制度', description: '浏览法规与条款', icon: BookMarked },
  { id: 'docs', label: '文档管理', description: '维护文档与历史版本', icon: FileText },
] as const

type HubTab = typeof TABS[number]['id']

function isHubTab(value: string | null): value is HubTab {
  return TABS.some((tab) => tab.id === value)
}

export default function KnowledgeHub() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const activeTab: HubTab = isHubTab(requestedTab) ? requestedTab : 'agent'
  const [draftRequest, setDraftRequest] = useState<{ question: string; id: number }>()
  const [configVersion, setConfigVersion] = useState(0)
  const isAdmin = getCurrentUser()?.role === 'admin'
  const knowledgeView: KnowledgeView = activeTab === 'regs' ? 'regs' : activeTab === 'docs' ? 'docs' : 'ask'

  const selectTab = (tab: HubTab) => {
    if (tab !== activeTab) setSearchParams({ tab })
  }

  const handleTabKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    if (!offset) return
    event.preventDefault()
    const next = TABS[(index + offset + TABS.length) % TABS.length]
    selectTab(next.id)
    document.getElementById(`knowledge-tab-${next.id}`)?.focus()
  }

  const analyzeQuestion = (question: string) => {
    setDraftRequest((current) => ({ question, id: (current?.id ?? 0) + 1 }))
    selectTab('agent')
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-1 py-2 sm:px-4 sm:py-6">
      <header>
        <div className="flex items-center gap-2">
          <BookOpen size={23} className="text-[#007AFF]" />
          <h1 className="text-[22px] font-bold tracking-tight text-neutral-900">知识检索</h1>
        </div>
        <p className="mt-1.5 text-[13px] leading-6 text-neutral-500">业务数据智能分析，知识原文与法规制度一站查询</p>
      </header>

      <div role="tablist" aria-label="知识检索功能" className="grid grid-cols-2 gap-1 rounded-2xl bg-neutral-200/60 p-1 sm:grid-cols-4">
        {TABS.map((tab, index) => {
          const Icon = tab.icon
          const selected = activeTab === tab.id
          return (
            <button
              key={tab.id}
              id={`knowledge-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`knowledge-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeys(event, index)}
              className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#007AFF]/30 ${selected ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800'}`}
            >
              <Icon size={15} className={selected ? 'text-[#007AFF]' : ''} />
              {tab.label}
            </button>
          )
        })}
      </div>

      <p className="-mt-2 px-1 text-[12px] leading-5 text-neutral-400">{TABS.find((tab) => tab.id === activeTab)?.description}</p>

      {isAdmin && <ModelSettings onSaved={() => setConfigVersion((version) => version + 1)} />}

      <section
        id="knowledge-panel-agent"
        role="tabpanel"
        aria-labelledby="knowledge-tab-agent"
        hidden={activeTab !== 'agent'}
      >
        <Agent embedded draftRequest={draftRequest} />
      </section>
      <section
        id={`knowledge-panel-${knowledgeView === 'ask' ? 'search' : knowledgeView}`}
        role="tabpanel"
        aria-labelledby={`knowledge-tab-${knowledgeView === 'ask' ? 'search' : knowledgeView}`}
        hidden={activeTab === 'agent'}
      >
        <Knowledge tab={knowledgeView} onAnalyze={analyzeQuestion} configVersion={configVersion} />
      </section>
    </div>
  )
}
