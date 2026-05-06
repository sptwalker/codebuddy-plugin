/**
 * 统计表格模板生成器
 *
 * 用于 Feature 2 (单轮结束统计表) 和 Feature 3 (/sum 日汇总表)
 *
 * ★ 第六阶段 UI 统一规范：
 *   表格符号约定：
 *   📋 本轮统计    ⏱ 耗时    ⏳ TTFT/延迟    📊 Token
 *   🚀 速率       📥 输入     📤 输出         📅 日期
 *   💬 轮次       ✅ 正常     ⚠️ 中断        ❌ 错误
 *
 * 数值格式化：
 *   - 时间: formatDuration (自动选 s / m s / h m s)
 *   - 数字: toLocaleString (千分位)
 *   - 速率: X.X chars/s (1位小数)
 *   - 无数据: "—"
 */

import type { DailyStats, TurnStats, TokenCount } from '../types/stats';
import { TurnFinishStatus } from '../types/stats';
import { buildMarkdownTable } from './markdownTable';
import { formatDuration } from '../core/timeTracker';

// ─── Feature 2: 单轮对话结束统计表 ──────────────────

/**
 * 生成单轮对话结束后的 Markdown 统计表格
 *
 * 三种状态输出样式统一：
 *
 * | 指标             | 数值              |
 * |------------------|-------------------|
 * | ⏱ 总耗时        | 3.24s             |
 * | ⏳ 首Token延迟   | 856ms             |
 * | 📊 Prompt Tokens | 256               |
 * | 📊 Completion Tokens | 1,024          |
 * | 📊 总 Token 消耗 | 1,280             |
 * | 🚀 流式输出速率   | 398.5 chars/s     |
 */
export function generateTurnSummaryTable(turn: TurnStats): string {
  const tc = turn.tokenCount;
  const isPartial = turn.finishStatus !== TurnFinishStatus.NORMAL;

  // Token 展示：
  //   - completion=0 且 responseLength=0 → 标注 "需官方支持"（CodeBuddy 不提供 transcript）
  //   - completion=0 但 responseLength>0 → 标注 "估算"
  //   - completion<0 → 标注 "不完整"
  //   - 正常值 → 加 "(est)" 后缀
  const formatPromptToken = (): string => {
    if (tc.promptTokens <= 0) return '\u2014';
    return tc.promptTokens.toLocaleString() + (tc.isEstimated ? ' (est)' : '');
  };

  const formatCompletionToken = (): string => {
    if (tc.completionTokens < 0) return '\u2014 (\u4e0d\u5b8c\u6574)';
    if (tc.completionTokens === 0) {
      if (turn.responseLength > 0) return '\u2014 (\u4f30\u7b97)';
      return '\u2014'; // CodeBuddy 官方 Hook 不提供 AI 回复正文
    }
    return tc.completionTokens.toLocaleString();
  };

  const formatTotalToken = (): string => {
    if (tc.totalTokens < 0) return '\u2014';
    if (tc.completionTokens === 0 && tc.promptTokens > 0)
      return tc.promptTokens.toLocaleString() + ' (prompt only)';
    return tc.totalTokens.toLocaleString() + (tc.isEstimated ? ' (est)' : '');
  };

  // 输出速率
  const speedStr = turn.responseLength > 0
    ? `${turn.outputSpeedCharsPerSec.toFixed(1)} chars/s`
    : '\u2014';

  // 表格标题根据状态调整
  let title = '📋 \u672c\u8f6e\u7edf\u8ba1';
  switch (turn.finishStatus) {
    case TurnFinishStatus.INTERRUPTED:
      title = '📋 \u672c\u8f6e\u7edf\u8ba1\uff08\u5df2\u4e2d\u65ad\uff09';
      break;
    case TurnFinishStatus.ERROR:
      title = '📋 \u672c\u8f6e\u7edf\u8ba1\uff08\u8bf7\u6c42\u5931\u8d25\uff09';
      break;
  }

  return buildMarkdownTable(
    [title, '数值'],
    [
      ['⏱ \u603b\u8017\u65f6', turn.durationReadable],
      ['⏳ \u9996Token\u5ef6\u8fdf(TTFT)', turn.ttftMs > 0 ? turn.ttftReadable : '\u2014'],
      ['📊 Prompt Tokens', formatPromptToken()],
      ['📊 Completion Tokens', formatCompletionToken()],
      ['📊 \u603b Token \u6d88\u8017', formatTotalToken()],
      ['🚀 \u6d41\u5f0f\u8f93\u51fa\u901f\u7387', speedStr],
    ],
    ['right', 'left']
  );
}

// ─── Feature 3: 日汇总统计表 (/sum) ─────────────────

interface SummaryTableOptions {
  titleDate?: string;
}

/**
 * 生成当日所有对话汇总的 Markdown 统计表格
 *
 * 核心字段（用户需求 6 项）+ 扩展辅助字段
 *
 * ### 📊 CodeBuddy 日统计 — YYYY-MM-DD
 *
 * | 指标                | 数值           |
 * |---------------------|----------------|
 * | 📅 日期            | YYYY-MM-DD     |
 * | 💬 对话总轮次       | 12             |
 * | ⏱ 合计总耗时       | 5m 32s         |
 * | 🚀 平均响应速度     | 398.5 chars/s  |
 * | 📥 总输入 Token     | 3,072          |
 * | 📤 总输出 Token     | 12,288         |
 * | 📊 合计总消耗       | 15,360         |
 * | ...辅助参考...      |                |
 */
export function generateDailySummaryTable(
  daily: DailyStats,
  options?: SummaryTableOptions
): string {
  const avgDurMs = daily.totalTurns > 0 ? daily.totalDurationMs / daily.totalTurns : 0;
  const avgTok = daily.totalTurns > 0 ? Math.round(daily.totalTokens / daily.totalTurns) : 0;
  const displayDate = options?.titleDate ?? daily.date;

  const table = buildMarkdownTable(
    ['指标', '数值'],
    [
      // ═══ 核心统计（需求 6 字段）═══
      ['📅 \u65e5\u671f', displayDate],
      ['💬 \u5bf9\u8bdd\u603b\u8f6e\u6b21', String(daily.totalTurns)],
      ['⏱ \u5408\u8ba1\u603b\u8017\u65f6', formatDuration(daily.totalDurationMs)],
      ['🚀 \u5e73\u5747\u54cd\u5e94\u901f\u5ea6', daily.avgOutputSpeedCharsPerSec > 0 ? `${daily.avgOutputSpeedCharsPerSec.toFixed(1)} chars/s` : '\u2014'],
      ['📥 \u603b\u8f93\u5165 Token (Prompt)', fmtNum(daily.totalPromptTokens) + (daily.totalPromptTokens > 0 ? ' (est)' : '')],
      // Completion Tokens: CodeBuddy 官方 Hook 不提供 AI 回复正文，此字段暂不可用
      ['📤 \u603b\u8f93\u51fa Token (Completion)', daily.totalCompletionTokens > 0 ? fmtNum(daily.totalCompletionTokens) + ' (est)' : '\u2014 (\u9700\u5b98\u65b9\u652f\u6301)'],
      ['📊 \u5408\u8ba1\u603b\u6d88\u8017 Token', fmtNum(daily.totalTokens)],
      // ═══ 扩展辅助信息 ═══
      ['⏳ \u5e73\u5747\u9996Token\u5ef6\u8fdf(TTFT)', formatDuration(daily.avgTtftMs)],
      ['**\u2500\u2500 \u8f85\u52a9\u53c2\u8003 \u2500\u2500**', '**\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500**'],
      ['⏯ \u5e73\u5747\u8017\u65f6/\u8f6e', formatDuration(avgDurMs)],
      ['📯 \u5e73\u5747 Token/\u8f6e', fmtNum(avgTok)],
    ],
    ['right', 'left']
  );

  return `### 📊 CodeBuddy \u65e5\u7edf\u8ba1 \u2014 ${displayDate}\n\n${table}`;
}

// ─── 详细明细表（各轮次逐条） ────────────────────────

/**
 * 生成当日所有对话轮次的明细列表表格
 */
export function generateTurnDetailTable(daily: DailyStats): string {
  const rows = daily.turns.map((turn, idx) => [
    `#${idx + 1}`,
    turn.durationReadable,
    turn.ttftReadable,
    String(turn.tokenCount.totalTokens),
    turn.userMessagePreview || '(空)',
  ]);

  return buildMarkdownTable(
    ['#', '⏱ \u8017\u65f6', '⏳ \u5ef6\u8fdf', '📊 Tokens', '💬 \u6458\u8981'],
    rows,
    ['right', 'left', 'left', 'right', 'left']
  );
}

// ─── 内部工具 ────────────────────────────────────────

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}
