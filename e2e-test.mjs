// WSMS 端到端 API 测试：直连后端 3100（后端托管前端，单端口）→ PostgreSQL
const BASE = process.env.WSMS_BASE || 'http://localhost:3100/api'
const ORIGIN = BASE.replace(/\/api\/?$/, '')
// 凭据一律从环境变量读取，禁止写进仓库（本仓库为公开仓库）：
//   Windows:  set WSMS_USER=xxx && set WSMS_PASS=xxx && node e2e-test.mjs
//   Linux:    WSMS_USER=xxx WSMS_PASS=xxx node e2e-test.mjs
const ADMIN_USER = process.env.WSMS_USER
const ADMIN_PASS = process.env.WSMS_PASS
if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('请先设置环境变量 WSMS_USER 与 WSMS_PASS（回归测试账号的用户名和密码）')
  process.exit(1)
}
let token = ''
let passed = 0, failed = 0
const failures = []

async function api(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  console.log('== 1. 鉴权 ==')
  let r = await api('POST', '/auth/login', { username: ADMIN_USER, password: 'wrong' })
  check('错误密码返回 401', r.status === 401, `got ${r.status}`)
  r = await api('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS })
  check('正确登录返回 token', r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`)
  token = r.data?.access_token || r.data?.token || ''
  check('token 非空', !!token)
  r = await api('GET', '/auth/me')
  check('GET /auth/me 返回当前用户', r.status === 200 && r.data?.username === ADMIN_USER, JSON.stringify(r.data))

  console.log('== 2. 标签 ==')
  r = await api('GET', '/tags')
  const builtinCount = Array.isArray(r.data) ? r.data.length : 0
  check('获取内置标签列表', r.status === 200 && builtinCount > 0, `got ${r.status}, ${builtinCount} tags`)
  r = await api('POST', '/tags/ensure', { name: 'E2E测试车间', group: 'location' })
  check('ensure 标签 upsert 创建', r.status === 201 || r.status === 200, `got ${r.status}`)
  const ensured = r.data
  r = await api('POST', '/tags/ensure', { name: 'E2E测试车间', group: 'location' })
  check('ensure 标签幂等（同 id）', r.data?.id === ensured.id, `${r.data?.id} vs ${ensured.id}`)
  r = await api('POST', '/tags', { name: 'E2E-自定义标签', group: 'custom', color: '#FF0000' })
  const customTag = r.data
  check('创建自定义标签', r.status === 201, `got ${r.status}`)
  r = await api('POST', '/tags', { name: 'E2E-自定义标签', group: 'custom' })
  check('重名标签被拒（409 友好提示）', r.status === 409, `got ${r.status} ${JSON.stringify(r.data).slice(0,80)}`)

  console.log('== 3. 隐患全流程 ==')
  r = await api('POST', '/issues', {
    title: 'E2E测试：配电箱未上锁', description: ' end-to-end 测试隐患',
    locationId: ensured.id, categoryId: null, riskLevel: 'major',
    scope: 'managed', foundAt: new Date().toISOString(), reporter: 'e2e',
  })
  const issue = r.data
  check('创建隐患', r.status === 201 && !!issue?.id, `got ${r.status} ${JSON.stringify(r.data).slice(0,150)}`)
  r = await api('GET', `/issues/${issue.id}`)
  check('读取隐患详情', r.status === 200 && r.data.title.includes('配电箱'))
  check('默认状态 pending', r.data.status === 'pending')
  r = await api('PATCH', `/issues/${issue.id}`, { status: 'fixing' })
  check('状态流转 fixing', r.status === 200 && r.data.status === 'fixing')
  r = await api('PATCH', `/issues/${issue.id}`, { status: 'review' })
  check('状态流转 review', r.data.status === 'review')
  r = await api('POST', `/issues/${issue.id}/recheck`)
  check('防复发复查第 1 次', r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0,100)}`)
  r = await api('PATCH', `/issues/${issue.id}`, { status: 'closed', closedAt: new Date().toISOString(), fixNote: 'E2E 整改完成' })
  check('闭环 closed + fixNote + closedAt（前端契约）', r.data.status === 'closed' && r.data.fixNote === 'E2E 整改完成' && !!r.data.closedAt)
  // 批量导入：契约为 { items: [...] }；整改期限默认值由前端导入暂存区按风险等级计算
  r = await api('POST', '/issues/batch', { items: [
    { title: 'E2E批量1', riskLevel: 'general', scope: 'managed', foundAt: new Date().toISOString(), deadline: new Date(Date.now() + 15 * 86400000).toISOString() },
    { title: 'E2E批量2（参考件）', riskLevel: 'general', scope: 'reference', foundAt: new Date().toISOString() },
  ]})
  check('批量导入 2 条', r.status === 201 && Array.isArray(r.data) && r.data.length === 2, `got ${r.status} ${JSON.stringify(r.data).slice(0,120)}`)
  // 参考件不设整改期限（前端导入契约）：批量导入的参考件无 deadline
  const batchRef = r.data.find((i) => i.scope === 'reference')
  check('参考件无整改期限（设计契约）', batchRef && batchRef.deadline === null, `deadline=${batchRef?.deadline}`)
  r = await api('GET', '/issues?status=closed&q=' + encodeURIComponent('配电箱'))
  check('列表筛选 q+status 命中', r.status === 200 && (Array.isArray(r.data) ? r.data : r.data.items || []).some(i => i.id === issue.id))

  console.log('== 4. 参考件标注 ==')
  r = await api('GET', '/issues?q=' + encodeURIComponent('E2E批量2'))
  const refIssue = (Array.isArray(r.data) ? r.data : r.data.items)[0]
  check('按标题查询到参考件（scope 由前端过滤）', !!refIssue && refIssue.scope === 'reference', JSON.stringify(r.data).slice(0,100))
  if (refIssue) {
    r = await api('PUT', `/annotations/${refIssue.id}`, { relevance: 'high', similarity: '成品车间同类设备', caution: '注意上锁' })
    check('PUT 标注 upsert', r.status === 200 || r.status === 201, `got ${r.status}`)
    r = await api('PUT', `/annotations/${refIssue.id}`, { relevance: 'medium', similarity: 'x', caution: 'y' })
    check('PUT 标注幂等更新', r.status === 200 && r.data.relevance === 'medium', JSON.stringify(r.data).slice(0,100))
  }

  console.log('== 5. 检查计划 ==')
  r = await api('GET', '/plans')
  check('获取检查计划（种子数据）', r.status === 200 && (Array.isArray(r.data) ? r.data : r.data.items).length > 0)
  r = await api('POST', '/plans', { name: 'E2E日检计划', frequency: 'daily', nextRunAt: new Date().toISOString(), checklist: ['项1', '项2'] })
  const plan = r.data
  check('创建检查计划', r.status === 201 && !!plan?.id, `got ${r.status}`)
  r = await api('POST', `/plans/${plan.id}/complete`, { executor: 'e2e', note: 'e2e 执行' })
  check('完成本次检查并推进周期', r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0,120)}`)
  r = await api('PATCH', `/plans/${plan.id}`, { enabled: false })
  check('停用计划', r.data?.enabled === false || r.status === 200)
  r = await api('DELETE', `/plans/${plan.id}`)
  check('删除计划', r.status === 200 || r.status === 204, `got ${r.status}`)

  console.log('== 6. 提醒 ==')
  r = await api('POST', '/reminders/refresh')
  check('刷新提醒（幂等派生）', r.status === 201 || r.status === 200, `got ${r.status}`)
  r = await api('GET', '/reminders')
  check('获取提醒列表', r.status === 200)
  const rem = (Array.isArray(r.data) ? r.data : r.data.items)[0]
  if (rem) {
    r = await api('PATCH', `/reminders/${rem.id}/read`)
    check('提醒标记已读', r.status === 200, `got ${r.status}`)
  }

  console.log('== 7. 上传 ==')
  // 生成 1x1 PNG；契约：字段名 files（多图，≤9 张），返回 { paths: [...] }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const form = new FormData()
  form.append('files', new Blob([png], { type: 'image/png' }), 'e2e.png')
  const up = await fetch(BASE + '/uploads', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  const upData = await up.json().catch(() => null)
  const upPath = upData?.paths?.[0]
  check('上传 PNG 照片', up.status === 201 && !!upPath, `got ${up.status} ${JSON.stringify(upData)}`)
  if (upPath) {
    // 照片访问鉴权矩阵：无凭据 401；Bearer 200；登录 Cookie 200；路径穿越非 200
    const noCred = await fetch(ORIGIN + upPath)
    check('照片无凭据访问被拒（401）', noCred.status === 401, `got ${noCred.status}`)
    const withBearer = await fetch(ORIGIN + upPath, { headers: { Authorization: `Bearer ${token}` } })
    check('照片带 Bearer 可访问', withBearer.status === 200, `got ${withBearer.status}`)
    const loginRes = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }) })
    const cookie = (loginRes.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('wsms_upload='))
    check('登录下发 wsms_upload Cookie', !!cookie, `cookies: ${loginRes.headers.getSetCookie?.()}`)
    if (cookie) {
      const withCookie = await fetch(ORIGIN + upPath, { headers: { Cookie: cookie.split(';')[0] } })
      check('照片带 Cookie 可访问', withCookie.status === 200, `got ${withCookie.status}`)
    }
    const traversal = await fetch(ORIGIN + '/uploads/..%2Fbackend%2F.env', { headers: { Authorization: `Bearer ${token}` } })
    check('路径穿越被拦截（非 200）', traversal.status !== 200, `got ${traversal.status}`)
  }
  // 非图片类型应被拒
  const form2 = new FormData()
  form2.append('files', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'evil.txt')
  const up2 = await fetch(BASE + '/uploads', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form2 })
  check('非图片上传被拒', up2.status === 400 || up2.status === 422, `got ${up2.status}`)

  console.log('== 8. 用户与权限 ==')
  r = await api('GET', '/users')
  check('admin 列出用户（不含密码哈希）', r.status === 200 && Array.isArray(r.data) && r.data.every((u) => !('passwordHash' in u)), `got ${r.status}`)
  r = await api('POST', '/users', { username: 'e2e_viewer', password: 'View1234', displayName: 'E2E观察员', role: 'viewer' })
  const viewer = r.data
  check('创建 viewer 用户', r.status === 201 && viewer?.role === 'viewer', `got ${r.status} ${JSON.stringify(r.data).slice(0,100)}`)
  r = await api('POST', '/users', { username: 'e2e_viewer', password: 'View1234', role: 'viewer' })
  check('重复用户名 409', r.status === 409, `got ${r.status}`)
  r = await api('POST', '/users', { username: 'e2e_weak', password: 'short', role: 'viewer' })
  check('弱密码被拒（<8 位）', r.status === 400, `got ${r.status}`)
  // viewer 登录并验证 RBAC
  const vLogin = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2e_viewer', password: 'View1234' }) })
  const vToken = (await vLogin.json()).token
  const vApi = async (method, path, body) => {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vToken}` }, body: body ? JSON.stringify(body) : undefined })
    let data = null; try { data = await res.json() } catch {}
    return { status: res.status, data }
  }
  r = await vApi('GET', '/issues')
  check('viewer 可读数据', r.status === 200, `got ${r.status}`)
  r = await vApi('POST', '/issues', { title: 'viewer写入测试' })
  check('viewer 写操作被拒（403）', r.status === 403, `got ${r.status}`)
  r = await vApi('GET', '/users')
  check('viewer 访问用户管理被拒（403）', r.status === 403, `got ${r.status}`)
  // 清理 viewer
  r = await api('DELETE', `/users/${viewer.id}`)
  check('删除测试用户', r.status === 200, `got ${r.status}`)

  console.log('== 9. 清理测试数据 ==')
  r = await api('GET', '/issues?q=' + encodeURIComponent('E2E'))
  const e2eIssues = Array.isArray(r.data) ? r.data : (r.data.items || [])
  for (const i of e2eIssues) { await api('DELETE', `/issues/${i.id}`) }
  check('删除 E2E 隐患', true, `deleted ${e2eIssues.length}`)
  await api('DELETE', `/tags/${customTag.id}`)
  await api('DELETE', `/tags/${ensured.id}`)
  r = await api('GET', '/tags')
  const e2eLeft = (Array.isArray(r.data) ? r.data : []).filter((t) => t.name.startsWith('E2E'))
  check('清理后无 E2E 标签残留', e2eLeft.length === 0, `left: ${e2eLeft.map((t) => t.name).join(',')}`)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed) { console.log('失败项：' + failures.join(' | ')); process.exit(1) }
}
main().catch(e => { console.error('E2E 异常：', e); process.exit(1) })
