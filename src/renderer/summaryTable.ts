/**
 * 统计表格模板生成器
 *
 * 用于 Feature 2 (单轮结束统计表) 和 Feature 3 (/sum 日汇总表)
 *
 * v0.2.0 精简版 — 仅展示可准确统计的字段：
 *   - ⏱ 总耗时（OfficialHookBridge E1/E3 精确计时）
 *   - 📊 Prompt Token（tiktoken 编码估算）
 *   - 📊 总 Token 消耗
 *
 * 以下字段因 CodeBuddy 架构限制暂不可用，已从表格中移除：
 *   TTFT / Completion Tokens / 流式输出速度
 */

import type { DailyStats, TurnStats, TokenCount } from '../types/stats';
import { TurnFinishStatus } from '../types/stats';
import { buildMarkdownTable } from './markdownTable';
import { formatDuration } from '../core/timeTracker';

// ─── Feature 2: 单轮对话结束统计表 ──────────────────

export function generateTurnSummaryTable(turn: TurnStats): string {
  const tc = turn.tokenCount;

  const formatPromptToken = (): string => {
    if (tc.promptTokens <= 0) return '\u2014';
    return tc.promptTokens.toLocaleString() + (tc.isEstimated ? ' (est)' : '');
  };

  const formatTotalToken = (): string => {
    if (tc.totalTokens < 0) return '\u2014';
    return tc.totalTokens.toLocaleString() + (tc.isEstimated ? ' (est)' : '');
  };

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
      ['📊 Prompt Tokens', formatPromptToken()],
      ['📊 \u603b Token \u6d88\u8017', formatTotalToken()],
      ['💬 \u7528\u6237\u6d88\u606f', turn.userMessagePreview || '(空)'],
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
  const displayDate = options?.titleDate ?? daily.date;

  const table = buildMarkdownTable(
    ['指标', '数值'],
    [
      ['📅 \u65e5\u671f', displayDate],
      ['💬 \u5bf9\u8bdd\u603b\u8f6e\u6b21', String(daily.totalTurns)],
      ['⏱ \u5408\u8ba1\u603b\u8017\u65f6', formatDuration(daily.totalDurationMs)],
      ['📥 \u603b\u8f93\u5165 Token (Prompt)', fmtNum(daily.totalPromptTokens) + (daily.totalPromptTokens > 0 ? ' (est)' : '')],
      ['📊 \u5408\u8ba1\u603b\u6d88\u8017 Token', fmtNum(daily.totalTokens)],
      ['**\u2500\u2500 \u8f85\u52a9\u53c2\u8003 \u2500\u2500**', '**\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500**'],
      ['⏯ \u5e73\u5747\u8017\u65f6/\u8f6e', formatDuration(avgDurMs)],
      ['📯 \u5e73\u5747 Token/\u8f6e', daily.totalTurns > 0 ? String(Math.round(daily.totalTokens / daily.totalTurns)) : '\u2014'],
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
    String(turn.tokenCount.totalTokens),
    turn.userMessagePreview || '(空)',
    turn.finishStatus === TurnFinishStatus.NORMAL ? '✅' :
      turn.finishStatus === TurnFinishStatus.INTERRUPTED ? '⚠️' : '❌',
  ]);

  return buildMarkdownTable(
    ['#', '⏱ \u8017\u65f6', '📊 Tokens', '\u6458\u8981', '\u72b6\u6001'],
    rows,
    ['right', 'left', 'right', 'left', 'center']
  );
}

// ─── 内部工具 ────────────────────────────────────────

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}
