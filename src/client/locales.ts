/** Mobile-chrome copy (the 'mobile' dictionary namespace). */
export type MobileKey =
  | 'menu.open'
  | 'menu.close'

export const zh = {
  'menu.open': '打开侧边栏',
  'menu.close': '关闭侧边栏',
} satisfies Record<MobileKey, string>

export const en = {
  'menu.open': 'Open sidebar',
  'menu.close': 'Close sidebar',
} satisfies Record<MobileKey, string>
