/**
 * 本地存储管理器
 *
 * 封装 vscode.ExtensionContext.globalState 的读写操作
 * 提供按自然日分桶的统计数据的 CRUD 能力
 *
 * 第六阶段增强：
 *   - 自动数据治理：每次写入时触发过期清理（默认 30 天）
 *   - 跨日自动隔离：检测日期切换并自动创建新桶，带日志记录
 *   - 存储操作全量日志：读写、清理、错误均有结构化日志
 */

import * as vscode from 'vscode';
import type { EnhancedStatsRoot, DailyStats, TurnStats, TokenCount } from '../types/stats';
import { STORAGE_ROOT_KEY, createEmptyRoot } from '../types/stats';
import { getTodayStr } from '../utils/dateUtil';
import { logInfo, logWarn, logError, logDebug } from '../utils/errorGuard';
import { appendTurnToBucket, rebuildAggregates } from './dailyBucket';

// ─── 并发写保护 ────────────────────────────────────────

/**
 * 写锁：防止并发 appendTurnStats 导致的 write-write 数据丢失
 *
 * VS Code globalState.update 是异步操作，如果在一次 write 完成前又触发了新的 read→modify→write，
 * 后者的 read 会读到旧数据（前者尚未写入），导致前者的数据被覆盖。
 *
 * 解决方案：简单的 Promise 队列，确保写操作串行执行。
 */
let _writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(writeFn: () => Promise<T>): Promise<T> {
  const wrapped: () => Promise<unknown> = writeFn;
  _writeQueue = _writeQueue.then(wrapped).then(
    (result) => result,
    (error) => { throw error; }  // re-throw 保持 reject 状态
  );
  return _writeQueue as Promise<T>;
}

// ─── 内部辅助 ───────────────────────────────────────

/** 创建空的日期桶 */
export function createEmptyDailyBucket(date: string): DailyStats {
  return {
    date,
    turns: [],
    totalTurns: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTtftMs: 0,
    avgTtftMs: 0,
    totalResponseLength: 0,
    avgOutputSpeedCharsPerSec: 0,
  };
}

/** 从 globalState 读取完整根对象，失败则返回空根 */
async function readRoot(context: vscode.ExtensionContext): Promise<EnhancedStatsRoot> {
  try {
    const data = await context.globalState.get<EnhancedStatsRoot>(STORAGE_ROOT_KEY);
    if (!data || !data.dailyBuckets) {
      logDebug('[Storage] No existing root data, creating empty');
      return createEmptyRoot();
    }
    // 版本迁移点：未来可在此处做 schema 升级
    logDebug(`[Storage] Root loaded | version=${data.version} | buckets=${Object.keys(data.dailyBuckets).length}`);
    return data;
  } catch (e) {
    logError('[Storage] Failed to read globalState root', e);
    return createEmptyRoot();
  }
}

/** 将根对象写入 globalState */
async function writeRoot(
  context: vscode.ExtensionContext,
  root: EnhancedStatsRoot,
  reason: string = ''
): Promise<void> {
  try {
    await context.globalState.update(STORAGE_ROOT_KEY, root);
    const bucketCount = Object.keys(root.dailyBuckets).length;
    logDebug(`[Storage] Written to globalState | reason=${reason} | buckets=${bucketCount}`);
  } catch (e) {
    logError('[Storage] Failed to write globalState root', e);
  }
}

// ─── 对外暴露的核心方法 ──────────────────────────────

/**
 * [方法 1] 读取单日统计数据
 *
 * @param context   ExtensionContext
 * @param dateStr   日期字符串 YYYY-MM-DD，默认今天
 * @returns 当日 DailyStats，不存在则返回空桶
 */
export async function readDailyStats(
  context: vscode.ExtensionContext,
  dateStr?: string
): Promise<DailyStats> {
  const target = dateStr ?? getTodayStr();
  const root = await readRoot(context);
  const bucket = root.dailyBuckets[target];

  if (!bucket) {
    logDebug(`[Storage] readDailyStats | date=${target} → empty bucket`);
    return createEmptyDailyBucket(target);
  }

  logDebug(`[Storage] readDailyStats | date=${target} | turns=${bucket.totalTurns}`);
  return bucket;
}

/**
 * [方法 2] 累加单轮数据到当日分桶并持久化
 *
 * ★ 第六阶段增强：
 *   - 自动跨日隔离（dateKey 取自 turn.startTime，天然按日分桶）
 *   - 写入后自动触发过期数据清理
 *   - 全程结构化日志记录
 *
 * @param context ExtensionContext
 * @param turn    单轮统计数据
 */
export async function appendTurnStats(
  context: vscode.ExtensionContext,
  turn: TurnStats
): Promise<void> {
  // ★ 通过写队列串行化，防止并发写入导致数据丢失
  return enqueueWrite(async () => {
    const root = await readRoot(context);
    const dateKey = turn.startTime.slice(0, 10);
    const todayKey = getTodayStr();

    // ── 跨日检测与日志 ──
    if (dateKey !== todayKey) {
      logWarn(
        `[Storage] Cross-day write detected | turnDate=${dateKey} | today=${todayKey}` +
        ` | turnId=${turn.turnId}`
      );
    }

    let bucket = root.dailyBuckets[dateKey];
    if (!bucket) {
      bucket = createEmptyDailyBucket(dateKey);
      root.dailyBuckets[dateKey] = bucket;
      logInfo(`[Storage] New bucket created | date=${dateKey}`);
    }

    // 追加数据并更新聚合字段
    appendTurnToBucket(bucket, turn);

    // 持久化
    await writeRoot(context, root, `appendTurn:${turn.turnId}`);

    // ── 自动清理过期数据 ──
    // 每次写入后检查是否需要清理（低频调用，不影响性能）
    await runAutoCleanupIfNeeded(context);

    logInfo(
      `[Storage] Turn persisted | turn=${turn.turnId} | date=${dateKey}` +
      ` | duration=${turn.durationMs}ms | tokens=${turn.tokenCount.totalTokens}` +
      ` | status=${turn.finishStatus}` +
      ` | dailyTotal=${bucket.totalTurns} turns`
    );
  });
}

/**
 * [方法 3] 保存/更新每日统计（全量覆盖写）
 *
 * 适用场景：修复数据、批量导入、清理后回写
 *
 * @param context ExtensionContext
 * @param daily   要保存的 DailyStats 对象
 */
export async function saveDailyStats(
  context: vscode.ExtensionContext,
  daily: DailyStats
): Promise<void> {
  const root = await readRoot(context);
  rebuildAggregates(daily);
  root.dailyBuckets[daily.date] = daily;
  await writeRoot(context, root, `saveDaily:${daily.date}`);
  logInfo(`[Storage] Daily stats saved | date=${daily.date} | turns=${daily.totalTurns}`);
}

/**
 * [方法 4] 读取当日全部数据（快捷方法）
 *
 * 等效于 readDailyStats(context, today)
 *
 * @param context ExtensionContext
 * @returns 今日 DailyStats
 */
export async function readTodayStats(
  context: vscode.ExtensionContext
): Promise<DailyStats> {
  return readDailyStats(context, getTodayStr());
}

// ─── 数据治理 ─────────────────────────────────────────

/**
 * 清理 N 天前的历史分桶数据
 *
 * @param context       ExtensionContext
 * @param olderThanDays 保留最近 N 天的数据
 * @returns 被清理的日期数量
 */
export async function cleanupOldBuckets(
  context: vscode.ExtensionContext,
  olderThanDays: number
): Promise<number> {
  if (olderThanDays <= 0) return 0;

  const root = await readRoot(context);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  const cutoffStr =
    `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

  let removed = 0;
  const removedKeys: string[] = [];
  for (const key of Object.keys(root.dailyBuckets)) {
    if (key < cutoffStr) {
      removedKeys.push(key);
      delete root.dailyBuckets[key];
      removed++;
    }
  }

  if (removed > 0) {
    await writeRoot(context, root, `cleanup:${removed}d`);
    logInfo(
      `[Storage] Auto-cleanup completed | removed=${removed} buckets` +
      ` | keys=[${removedKeys.join(', ')}]` +
      ` | retention=${olderThanDays} days`
    );
  }
  return removed;
}

/**
 * 获取所有已存储的日期键列表（排序后）
 */
export async function getAllStoredDates(
  context: vscode.ExtensionContext
): Promise<string[]> {
  const root = await readRoot(context);
  return Object.keys(root.dailyBuckets).sort();
}

/**
 * 执行自动过期数据清理（如果配置允许）
 *
 * 在每次 appendTurnStats 后自动调用。
 * 通过读取 globalState 的 __enhance_config 获取保留天数配置，
 * 若未配置则使用 DEFAULT_CONFIG.autoCleanupDays（30 天）。
 *
 * 性能保障：仅在最近一次清理超过 1 小时时才重新执行，避免频繁 IO。
 */
let _lastCleanupTime = 0;
const CLEANUP_COOLDOWN_MS = 3600_000; // 1 小时冷却

async function runAutoCleanupIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const now = Date.now();
  if (now - _lastCleanupTime < CLEANUP_COOLDOWN_MS) return;

  let cleanupDays = 30; // 默认值
  try {
    const cfg = context.globalState.get<{ autoCleanupDays?: number }>('__enhance_config');
    if (cfg?.autoCleanupDays != null && cfg.autoCleanupDays > 0) {
      cleanupDays = cfg.autoCleanupDays;
    }
  } catch { /* 使用默认值 */ }

  _lastCleanupTime = now;
  await cleanupOldBuckets(context, cleanupDays);
}
