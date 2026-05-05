/**
 * 自然日分桶逻辑
 *
 * 负责按 YYYY-MM-DD 隔离每日数据，提供聚合计算能力
 *
 * ★ 第六阶段增强：
 *   - 每次追加/移除/重建操作均有日志记录（DEBUG 级别）
 *   - 数据一致性校验：dateKey 不匹配时拒绝写入并警告
 */

import type { DailyStats, TurnStats } from '../types/stats';
import { logDebug, logWarn } from '../utils/errorGuard';

/**
 * 向指定日期桶中追加一轮数据，并更新所有聚合字段（原地修改 bucket）
 */
export function appendTurnToBucket(bucket: DailyStats, turn: TurnStats): void {
  if (bucket.date !== turn.startTime.slice(0, 10)) {
    logWarn(
      `[dailyBucket] Date mismatch! bucket=${bucket.date}` +
      ` | turnDate=${turn.startTime.slice(0, 10)} | skipping`
    );
    return;
  }

  bucket.turns.push(turn);
  // 更新基础计数
  bucket.totalTurns += 1;
  bucket.totalDurationMs += turn.durationMs;
  bucket.totalTokens += turn.tokenCount.totalTokens;
  bucket.totalPromptTokens += turn.tokenCount.promptTokens;
  bucket.totalCompletionTokens += turn.tokenCount.completionTokens;
  // TTFT 累计
  bucket.totalTtftMs += turn.ttftMs;
  // 输出速率/长度累计
  bucket.totalResponseLength += turn.responseLength;

  // 实时重算平均值
  recalcAverages(bucket);

  logDebug(
    `[dailyBucket] Appended | date=${bucket.date} | totalTurns=${bucket.totalTurns}` +
    ` | duration=${turn.durationMs}ms | tokens=${turn.tokenCount.totalTokens}`
  );
}

/**
 * 从日期桶中移除一轮数据，回滚聚合字段
 * @returns 是否成功移除
 */
export function removeTurnFromBucket(bucket: DailyStats, turnId: string): boolean {
  const idx = bucket.turns.findIndex((t) => t.turnId === turnId);
  if (idx === -1) {
    logDebug(`[dailyBucket] removeTurn not found: ${turnId}`);
    return false;
  }

  const removed = bucket.turns.splice(idx, 1)[0];
  bucket.totalTurns -= 1;
  bucket.totalDurationMs -= removed.durationMs;
  bucket.totalTokens -= removed.tokenCount.totalTokens;
  bucket.totalPromptTokens -= removed.tokenCount.promptTokens;
  bucket.totalCompletionTokens -= removed.tokenCount.completionTokens;
  bucket.totalTtftMs -= removed.ttftMs;
  bucket.totalResponseLength -= removed.responseLength;

  recalcAverages(bucket);

  logDebug(`[dailyBucket] Removed | turnId=${turnId} | remaining=${bucket.totalTurns}`);
  return true;
}

/**
 * 从 turns 数组全量重建聚合字段
 * 用于数据修复、导入后的一致性保证
 */
export function rebuildAggregates(bucket: DailyStats): void {
  const n = bucket.turns.length;
  let dur = 0, tok = 0, ptok = 0, ctok = 0, ttft = 0, rlen = 0;

  for (const turn of bucket.turns) {
    dur += turn.durationMs;
    tok += turn.tokenCount.totalTokens;
    ptok += turn.tokenCount.promptTokens;
    ctok += turn.tokenCount.completionTokens;
    ttft += turn.ttftMs;
    rlen += turn.responseLength;
  }

  bucket.totalTurns = n;
  bucket.totalDurationMs = dur;
  bucket.totalTokens = tok;
  bucket.totalPromptTokens = ptok;
  bucket.totalCompletionTokens = ctok;
  bucket.totalTtftMs = ttft;
  bucket.totalResponseLength = rlen;

  recalcAverages(bucket);

  logDebug(
    `[dailyBucket] Rebuilt | date=${bucket.date}` +
    ` | turns=${n} | duration=${dur}ms | tokens=${tok}`
  );
}

/** 检查日期桶是否为空 */
export function isBucketEmpty(bucket: DailyStats): boolean {
  return bucket.turns.length === 0;
}

// ─── 内部：平均值重算 ────────────────────────────────

function recalcAverages(bucket: DailyStats): void {
  if (bucket.totalTurns > 0) {
    bucket.avgTtftMs = Math.round(bucket.totalTtftMs / bucket.totalTurns);
    const totalDurSec = Math.max(0.001, bucket.totalDurationMs / 1000);
    bucket.avgOutputSpeedCharsPerSec = bucket.totalResponseLength / totalDurSec / bucket.totalTurns;
  } else {
    bucket.avgTtftMs = 0;
    bucket.avgOutputSpeedCharsPerSec = 0;
  }
}
