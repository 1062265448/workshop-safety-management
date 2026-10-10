// 当前登录用户与登出工具
export interface CurrentUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'safety_officer' | 'viewer'
}

export function getCurrentUser(): CurrentUser | null {
  try {
    return JSON.parse(localStorage.getItem('wsms-user') ?? 'null')
  } catch {
    return null
  }
}

/** 登出：通知后端清除照片访问 Cookie，再清本地凭据 */
export function logout() {
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
  localStorage.removeItem('wsms-token')
  localStorage.removeItem('wsms-user')
  window.location.reload()
}

export const ROLE_LABEL: Record<CurrentUser['role'], string> = {
  admin: '管理员',
  safety_officer: '安全员',
  viewer: '查看者',
}
