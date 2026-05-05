/**
 * 日期工具函数
 * 提供 YYYY-MM-DD 格式化、跨日判断等能力
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 获取当前本地日期，格式 YYYY-MM-DD */
export function getTodayStr(): string {
  return formatDate(new Date());
}

/** 获取当前本地时间字符串，格式 YYYY-MM-DDTHH:mm:ss.sss */
export function getNowISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const min = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}`;
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
  return formatDate(d);
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
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
}
