/**
 * 日期工具函数
 * 提供 YYYY-MM-DD 格式化、跨日判断等能力
 */

/** 获取当前本地日期，格式 YYYY-MM-DD */
export function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 获取当前本地时间 ISO 字符串 */
export function getNowISO(): string {
  return new Date().toISOString();
}

/**
 * 判断给定日期字符串是否是今天（跨日检测）
 * @param dateStr 格式为 YYYY-MM-DD 的日期字符串
 */
export function isToday(dateStr: string): boolean {
  return dateStr === getTodayStr();
}

/** 获取 N 天前的日期字符串 YYYY-MM-DD */
export function getDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 判断 dateStr 是否早于 daysAgo 天前（用于自动清理） */
export function isOlderThan(dateStr: string, days: number): boolean {
  if (days <= 0) return false;
  return dateStr < getDaysAgo(days);
}

/**
 * 从 Date 对象生成 YYYY-MM-DD 字符串
 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
