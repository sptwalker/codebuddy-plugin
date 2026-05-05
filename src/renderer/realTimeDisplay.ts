/**
 * 实时计时显示格式化工具
 *
 * 生成 AI 输出行尾动态计时的显示文案
 *
 * ★ 第六阶段 UI 统一规范：
 *   - 流式阶段：` ⏱ 3.2s`（简洁，纯时间）
 *   - 完成阶段：` ⏱ 3.2s ✓ 📊 1,280 tok (256↑/1024↓) | 延迟：856ms`
 *   - 中断标记：`... ⚠️ 已中断`
 *   - 错误标记：`... ❌ 请求失败`
 *
 * 符号统一约定：
 *   ⏱ 计时    📊 Token    ↑ Prompt    ↓ Completion    ✓ 完成    ⚠️ 中断    ❌ 错误
 */

import { formatDuration } from '../core/timeTracker';

/** 实时计时显示配置 */
export interface RealTimeDisplayOptions {
  /** 是否显示 Token 数量（完成态启用） */
  showTokens?: boolean;
  /** prompt token 数 */
  promptTokens?: number;
  /** completion token 数 */
  completionTokens?: number;
  /** TTFT 延迟时间 ms */
  ttftMs?: number;
  /** 自定义前缀标签，默认 "⏱" */
  label?: string;
}

/**
 * 格式化实时计时文案（追加在 AI 输出文字后方）
 *
 * @param elapsedMs  当前已耗时 (ms)
 * @param isFinished 是否已完成
 * @param options    可选附加信息
 */
export function formatRealTimeDisplay(
  elapsedMs: number,
  isFinished: boolean = false,
  options?: RealTimeDisplayOptions
): string {
  const timeStr = formatDuration(elapsedMs);
  const label = options?.label ?? '⏱';

  // 基础：时间
  let result = ` ${label} ${timeStr}`;

  // 完成态标记
  if (isFinished) {
    result += ' \u2713'; // ✓
  }

  // Token 信息（仅完成态且有值时展示）
  if (options?.showTokens && (options.promptTokens! > 0 || options.completionTokens! > 0)) {
    const pt = options.promptTokens ?? 0;
    const ct = options.completionTokens ?? 0;
    result += ` \u{1F4CA} ${pt + ct.toLocaleString()} tok (${pt}\u2191/${ct}\u2193)`;
  }

  // TTFT（仅已获取到值时展示）
  if (options?.ttftMs != null && options.ttftMs > 0) {
    result += ` | \u5ef6\u8fdf\uff1a${formatDuration(options.ttftMs)}`;
  }

  return result;
}

/** 生成纯时间短标签（状态栏紧凑场景） */
export function formatShortTimeLabel(elapsedMs: number): string {
  return formatDuration(elapsedMs);
}
