/** 本系统的管理对象：成品车间。其他车间的通报问题仅作参考存档 */
export const MANAGED_WORKSHOP = '成品车间'

/** 判定车间名是否属于本系统管理范围 */
export function isManagedWorkshop(workshopName?: string): boolean {
  return !!workshopName && workshopName.includes('成品')
}
