/**
 * Engine — CodeBuddy Enhance 主引擎
 *
 * 职责：
 *   1. 协调所有子模块（Timer / TokenCounter / ChatInjector / Storage）
 *   2. 订阅 EventHookManager 的全部生命周期事件
 *   3. 实现 Feature 1: AI 输出行尾实时动态计时（核心功能）
 *   4. 管理"单轮对话"的完整状态机（IDLE → TIMING → FINALIZING → IDLE）
 *   5. 确保定时器清理、会话切换中断、请求失败容错、无内存泄漏
 *
 * ★ 第六阶段增强：
 *   - E4(中断)/E5(错误) 场景下也记录有效耗时和预估 Token，并持久化到日统计
 *   - 全链路结构化日志：计时开始/结束、Token 解析、数据存储均有日志
 *   - 定时器全局标签化管理，session change / new conv 时批量清理 ENGINE_REFRESH 类定时器
 *   - 刷新频率优化至 200ms + 值不变时跳过 DOM 更新（节流）
 *
 * Feature 1 行为规格:
 *   ┌─ E1 REQUEST_START → 启动 performance.now() 计时器
 *                          定位当前输出行
 *                          在行尾追加 "⏱ 0.0s"
 *                          启动 setInterval 每 200ms 刷新行尾文案
 *   ├─ E2 STREAM_CHUNK  → (计时器自动运行, 无需额外操作)
 *                          首个 chunk 记录 TTFT
 *   ├─ E3 RESPONSE_END  → 销毁 clearInterval
 *                          计算 Token 数量
 *                          替换行尾为 "[耗时 x.xs | Token: xxx] ✓"
 *                          构造 TurnStats → 持久化到 globalState
 *                          追加统计 Markdown 表格
 *   ├─ E4 SESSION_CHANGE → 强制停止计时, 记录部分数据, 持久化(含 INTERRUPTED 标记), 清理所有定时器
 *   └─ E5 REQUEST_ERROR  → 停止计时, 记录有效耗时+预估Token, 持久化(含 ERROR 标记), 清理所有定时器
 */

import * as vscode from 'vscode';

// 内部模块引用
import type { TurnStats, TokenCount } from '../types/stats';
import { TurnFinishStatus } from '../types/stats';
import { ChatLifecycleEvent, RequestStartPayload, StreamChunkPayload, ResponseEndPayload, RequestErrorPayload } from '../types/events';
import { DEFAULT_CONFIG } from '../types/config';

// 工具层
import {
  createTimer, startTimer, stopTimer, getElapsedMs,
  formatDuration, TimerState,
} from './timeTracker';
import { parseUsageFromAPI, estimateTokensLocally } from './tokenCounter';
import { locateCurrentOutputLine, appendDynamicText, replaceLineTailText, appendMarkdownTable, clearDisplay } from './chatInjector';
import { generateTurnSummaryTable } from '../renderer/summaryTable';
import { formatRealTimeDisplay } from '../renderer/realTimeDisplay';
import {
  getOrCreateStatsPanel,
  updateTimerDisplay as webviewUpdateTimer,
  setFinalResult as webviewSetFinalResult,
  appendMarkdownContent as webviewAppendMarkdown,
  clearContent as webviewClear,
  isStatsPanelVisible,
} from './statsWebviewPanel';
import { appendTurnStats } from '../storage/storageManager';
import { getTodayStr, getNowISO } from '../utils/dateUtil';
import {
  logInfo, logWarn, logError, logDebug, logTimerDebug,
  guardSync, guardAsync, initOutputChannel, disposeOutputChannel,
} from '../utils/errorGuard';
import {
  cleanupManager, disposeEngineTimersOnly, disposeAllTimers,
  safeSetIntervalForEngine, TimerTag,
} from '../utils/cleanup';

// Hook 层
import { eventHookManager } from '../hook/eventHookManager';

// ══════════════════════════════════════════════════════
// 引擎内部状态机
// ══════════════════════════════════════════════════════

/** 引擎当前所处状态 */
enum EngineState {
  /** 空闲：无进行中的对话 */
  IDLE = 'IDLE',
  /** 计时中：AI 正在流式输出 */
  TIMING = 'TIMING',
  /** 结束处理中：正在计算 Token、替换文案 */
  FINALIZING = 'FINALIZING',
}

/** 单轮对话上下文（引擎运行时的活跃数据） */
interface ActiveTurnContext {
  turnId: string;
  requestId: string;
  userMessage: string;
  startTimeISO: string;
  timer: TimerState;
  lineId: string | null;
  refreshTimerId: ReturnType<typeof setInterval> | null;
  config: typeof DEFAULT_CONFIG;
  // ─── TTFT (Time To First Token) ───
  ttftRecorded: boolean;
  ttftTimestamp: number;
  ttftMs: number;
  // ─── 流式输出累计 ───
  accumulatedResponseText: string;
  // ─── 结束状态 ───
  finishStatus: TurnFinishStatus;
  // ─── chunk 超时自动结束检测 ───
  /** 上次收到 chunk 的时间戳（用于超时判断） */
  lastChunkTimeMs: number;
  /** chunk 超时等待日志是否已输出（避免无 Stop 测试时刷屏） */
  chunkTimeoutSkipLogged: boolean;
  /** chunk 超时检测定时器 ID */
  chunkTimeoutId: ReturnType<typeof setTimeout> | null;
}

// ─── 全局引擎实例状态 ───────────────────────────────

let _state: EngineState = EngineState.IDLE;
let _ctx: ActiveTurnContext | null = null;
let _extensionCtx: vscode.ExtensionContext | null = null;

// ─── 显示节流：避免高频 DOM 更新 ─────────────────────
let _lastDisplayedMs = -1;       // 上次显示的时间值 ms（-1 表示未显示过）
let _lastDisplayStr = '';         // 上次显示的字符串（用于精确去重）

/** 获取当前引擎状态（只读） */
export function getEngineState(): EngineState { return _state; }

/** 获取当前活跃的轮次上下文（只读） */
export function getActiveTurn(): Readonly<ActiveTurnContext> | null { return _ctx; }

// ══════════════════════════════════════════════════════
// 引擎初始化与销毁
// ══════════════════════════════════════════════════════

/**
 * 初始化引擎（在 activate 中调用一次）
 *
 * @param context VS Code ExtensionContext
 * @param config  可选配置覆盖
 */
export function initEngine(
  context: vscode.ExtensionContext,
  config?: Partial<typeof DEFAULT_CONFIG>
): void {
  if (_extensionCtx) {
    logWarn('[Engine] Already initialized, skipping');
    return;
  }

  _extensionCtx = context;

  // 初始化输出通道
  initOutputChannel();

  const cfg = { ...DEFAULT_CONFIG, ...config };
  // 将配置持久化到 globalState，供 storageManager 的 autoCleanup 使用
  Promise.resolve(context.globalState.update('__enhance_config', cfg)).then(() => {
    logDebug('[Engine] Config persisted to globalState');
  }).catch(() => { /* ignore */ });

  // 注册所有事件监听
  bindEventListeners();

  // 注册 /sum 命令处理器
  import('../hook/commandInterceptor').then(({ setSumHandler }) => {
    setSumHandler(() => handleSumCommand());
    logInfo('[Engine] /sum handler registered');
  });

  logInfo(
    `[Engine] ✅ Initialized` +
    ` | refresh=${cfg.timerRefreshInterval}ms` +
    ` | autoCleanup=${cfg.autoCleanupDays}d` +
    ` | tiktoken=${cfg.enableTiktokenFallback}`
  );
}

/**
 * 销毁引擎（在 deactivate 中调用）
 *
 * 清理顺序（防止依赖倒置）：
 *   1. 停止当前活跃计时（forceStopCurrentTurn）
 *   2. 批量清理所有 Engine 标签定时器
 *   3. 解绑事件监听
 *   4. 全局定时器兜底清理
 *   5. 输出通道销毁
 *   6. 状态归零
 */
export function disposeEngine(): void {
  logInfo('[Engine] Disposing...');

  // 1. 停止当前活跃轮次的所有资源
  forceStopCurrentTurn();

  // 2. 批量清除 Engine 相关定时器
  const engineTimersCleared = disposeEngineTimersOnly();
  logDebug(`[Engine] Cleared ${engineTimersCleared} engine-specific timers`);

  // 3. 清理事件监听
  unbindEventListeners();

  // 4. 全局定时器兜底清理
  const totalCleared = disposeAllTimers();
  logInfo(`[Engine] Total timers cleared on dispose: ${totalCleared}`);

  // 5. 销毁输出通道
  disposeOutputChannel();

  _extensionCtx = null;
  _state = EngineState.IDLE;
  _ctx = null;
  _lastDisplayedMs = -1;
  _lastDisplayStr = '';

  logInfo('[Engine] ✅ Disposed completely');
}

// ══════════════════════════════════════════════════════
// 事件绑定 / 解绑
// ══════════════════════════════════════════════════════

function bindEventListeners(): void {
  eventHookManager.onRequestStart(handleRequestStart);
  eventHookManager.onStreamChunk(handleStreamChunk);
  eventHookManager.onResponseEnd(handleResponseEnd);
  eventHookManager.onSessionChange(handleSessionChange);
  eventHookManager.onRequestError(handleRequestError);
  logInfo('[Engine] Event listeners bound (E1-E5)');
}

function unbindEventListeners(): void {
  eventHookManager.offAll(ChatLifecycleEvent.REQUEST_START);
  eventHookManager.offAll(ChatLifecycleEvent.STREAM_CHUNK);
  eventHookManager.offAll(ChatLifecycleEvent.RESPONSE_END);
  eventHookManager.offAll(ChatLifecycleEvent.SESSION_CHANGE);
  eventHookManager.offAll(ChatLifecycleEvent.REQUEST_ERROR);
  logDebug('[Engine] Event listeners unbound');
}

// ══════════════════════════════════════════════════════
// Feature 1 核心实现：事件处理器
// ══════════════════════════════════════════════════════

/**
 * [E1] 处理「对话开始」事件
 *
 * 操作：
 *   1. 容错：检查前一轮是否未正常结束 → 强制收尾
 *   2. 创建新的计时器并启动 performance.now()
 *   3. 定位当前输出行
 *   4. 在行尾追加初始计时文案 "⏱ 0.0s"
 *   5. 启动 setInterval 定时刷新（带 ENGINE_REFRESH 标签）
 */
function handleRequestStart(payload: RequestStartPayload): void {
  // ★ 清理上一轮残留的状态栏状态
  clearDisplay();

  logInfo(`[Engine] ★★★ E1 REQUEST_START RECEIVED | requestId=${payload.requestId} | msg="${(payload.userMessage ?? '').slice(0, 50)}"`);

  // 容错：如果上一轮还在计时中，强制停止
  if (_state === EngineState.TIMING || _state === EngineState.FINALIZING) {
    logWarn(`[Engine] E1 Previous turn still active (state=${_state}), forcing stop`);
    forceStopCurrentTurn();
  }

  const config = _extensionCtx
    ? (_extensionCtx.globalState.get('__enhance_config') ?? DEFAULT_CONFIG)
    : DEFAULT_CONFIG;

  // 构建新的轮次上下文
  const turnId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  _ctx = {
    turnId,
    requestId: payload.requestId,
    userMessage: payload.userMessage || '',
    startTimeISO: getNowISO(),
    timer: createTimer(),
    lineId: null,
    refreshTimerId: null,
    config: { ...DEFAULT_CONFIG, ...(typeof config === 'object' ? config : {}) },
    ttftRecorded: false,
    ttftTimestamp: 0,
    ttftMs: 0,
    accumulatedResponseText: '',
    finishStatus: TurnFinishStatus.NORMAL,
    lastChunkTimeMs: performance.now(),
    chunkTimeoutSkipLogged: false,
    chunkTimeoutId: null,
  };

  // 启动高精度计时器
  startTimer(_ctx.timer);

  // 定位当前输出行
  _ctx.lineId = locateCurrentOutputLine();

  // ★ 初始化 Webview 统计面板（仅此一处负责创建，后续 update 方法不再重复创建）
  try { getOrCreateStatsPanel(); } catch { /* non-critical */ }

  // 重置节流缓存
  _lastDisplayedMs = -1;
  _lastDisplayStr = '';

  // ★ 同步重置 Webview 面板
  try { webviewClear(); } catch { /* non-critical */ }

  // 首次渲染：在行尾追加 "⏱ 0.0s"
  if (_ctx.lineId) {
    appendDynamicText(_ctx.lineId, formatRealTimeDisplay(0));
  }

  // 启动定时刷新循环（★ 带 ENGINE_REFRESH 标签，便于批量清理）
  _ctx.refreshTimerId = safeSetIntervalForEngine(() => {
    refreshTimerDisplay();
  }, _ctx.config.timerRefreshInterval, turnId);

  _state = EngineState.TIMING;

  // ★ 启动 chunk 超时检测（E1 时就开始计时）
  resetChunkTimeout();

  logInfo(
    `[Engine] E1 ⏱ TIMER_START | turn=${turnId}` +
    ` | line=${_ctx.lineId ?? 'null'}` +
    ` | refresh=${_ctx.config.timerRefreshInterval}ms`
  );
}

/**
 * 定时刷新行尾计时文案
 *
 * ★ 第六阶段性能优化：
 *   - 值不变跳过更新（整数秒级去重）：elapsed 变化不足 100ms 不重新写 DOM
 *   - 字符串级去重：生成文本与上次完全相同时跳过 appendDynamicText
 *   - 高频节流日志：通过 logTimerDebug 每 5 秒最多打一条
 */
function refreshTimerDisplay(): void {
  if (!_ctx || _state !== EngineState.TIMING || !_ctx.lineId) return;

  const elapsedMs = getElapsedMs(_ctx.timer);
  const elapsedInt = Math.floor(elapsedMs / 100) * 100; // 100ms 粒度比较

  // ★ 节流：值没变化则跳过 DOM 写入（减少 ~50% 无效渲染）
  if (elapsedInt === _lastDisplayedMs && _lastDisplayStr !== '') return;

  const currentTtft = _ctx.ttftMs > 0 ? _ctx.ttftMs : undefined;
  const displayText = formatRealTimeDisplay(elapsedMs, false, {
    ttftMs: currentTtft,
  });

  // ★ 二级节流：字符串完全相同也不写入
  if (displayText === _lastDisplayStr) return;

  appendDynamicText(_ctx.lineId, displayText);
  _lastDisplayedMs = elapsedInt;
  _lastDisplayStr = displayText;

  // ★ 同步更新 Webview 面板计时器（大字体动画显示）
  try { webviewUpdateTimer(elapsedMs, false); } catch { /* non-critical */ }

  logTimerDebug(_ctx.turnId, elapsedMs);
}

// ══════════════════════════════════════════════════════
// Chunk 超时自动结束检测
// ══════════════════════════════════════════════════════

/** chunk 停止后多久自动判定为"对话结束"（毫秒） */
const CHUNK_TIMEOUT_MS = 10000; // 10 秒无新 chunk → 触发 E3（原 3s 太短，AI 思考/排队常超 3s）

/** 最小响应长度阈值：累计文本少于此值时不触发自动结束 */
const MIN_AUTO_END_RESPONSE_LEN = 5; // 至少要有几个字符的响应才认为"真结束了"

/**
 * 重置 chunk 超时检测计时器
 * 每次收到 stream chunk 时调用，刷新超时截止时间
 */
function resetChunkTimeout(): void {
  if (!_ctx) return;

  // 清除旧的超时定时器
  if (_ctx.chunkTimeoutId != null) {
    clearTimeout(_ctx.chunkTimeoutId);
    _ctx.chunkTimeoutId = null;
  }

  _ctx.lastChunkTimeMs = performance.now();

  // 启动新的超时检测：CHUNK_TIMEOUT_MS 后如果还在 TIMING 状态 → 自动触发 E3
  _ctx.chunkTimeoutId = setTimeout(() => {
    if (!_ctx || _state !== EngineState.TIMING) return;

    // ★ 安全守卫：累计响应文本太短 → 不触发自动结束（可能是 AI 还在思考/排队）
    if (_ctx.accumulatedResponseText.length < MIN_AUTO_END_RESPONSE_LEN) {
      if (!_ctx.chunkTimeoutSkipLogged) {
        logInfo(
          `[Engine] ⏱ CHUNK_TIMEOUT_WAITING | turn=${_ctx.turnId}` +
          ` | responseLen=${_ctx.accumulatedResponseText.length} chars (threshold=${MIN_AUTO_END_RESPONSE_LEN})` +
          ` | 等待 Stop 或更多 chunk...`
        );
        _ctx.chunkTimeoutSkipLogged = true;
      } else {
        logDebug(
          `[Engine] ⏱ CHUNK_TIMEOUT_WAITING_SUPPRESSED | turn=${_ctx.turnId}` +
          ` | responseLen=${_ctx.accumulatedResponseText.length} chars`
        );
      }
      // 不重置为 IDLE，而是重新启动超时检测
      resetChunkTimeout();
      return;
    }

    const gapMs = performance.now() - _ctx.lastChunkTimeMs;
    logInfo(
      `[Engine] ⏱ CHUNK_TIMEOUT | turn=${_ctx.turnId}` +
      ` | gap=${gapMs.toFixed(0)}ms` +
      ` | responseLen=${_ctx.accumulatedResponseText.length} chars`
    );

    // 自动构造 ResponseEnd payload 并触发完成流程
    const autoEndPayload: ResponseEndPayload = {
      finalUsage: undefined, // 超时场景无 API usage
      fullResponseText: _ctx.accumulatedResponseText || undefined,
      userMessage: _ctx.userMessage || undefined,
    };

    handleResponseEnd(autoEndPayload).catch((e) => {
      logError('[Engine] Auto-end via timeout failed', e);
    });
  }, CHUNK_TIMEOUT_MS);
}

/** 清除 chunk 超时定时器 */
function clearChunkTimeout(): void {
  if (_ctx?.chunkTimeoutId != null) {
    clearTimeout(_ctx.chunkTimeoutId);
    _ctx.chunkTimeoutId = null;
  }
}

/**
 * [E2] 处理「流式输出 chunk」事件
 *
 * 核心职责：
 *   - 累计 AI 回复文本（用于计算速率 + 中断时的预估 Token）
 *   - 在首个 chunk 到达时记录 TTFT (Time To First Token)，仅记录一次
 *
 * TTFT = 首个 chunk 的 performance.now() - 请求发出时的 performance.now()
 */
function handleStreamChunk(payload: StreamChunkPayload): void {
  if (!_ctx || _state !== EngineState.TIMING) return;

  // 累计 AI 回复文本（用于计算流式输出速率 + 中断/错误时的 token 估算）
  if (payload.chunk) {
    _ctx.accumulatedResponseText += payload.chunk;
  }

  // ★ 重置 chunk 超时检测（每次收到 chunk 都刷新）
  resetChunkTimeout();

  // TTFT 仅在首个 chunk 时记录一次
  if (_ctx.ttftRecorded) return;

  const firstChunkTime = payload.timestamp ?? performance.now();
  _ctx.ttftTimestamp = firstChunkTime;
  _ctx.ttftMs = Math.max(0, firstChunkTime - _ctx.timer.startTime);
  _ctx.ttftRecorded = true;

  logInfo(
    `[Engine] E2 📥 FIRST_CHUNK | turn=${_ctx.turnId}` +
    ` | TTFT=${formatDuration(_ctx.ttftMs)}` +
    ` | chunkIndex=${payload.chunkIndex}`
  );
}

/**
 * [E3] 处理「对话结束」事件 — 正常完成
 *
 * 操作：
 *   1. 销毁 clearInterval 刷新定时器
 *   2. 停止 performance.now() 计时器，获取最终耗时
 *   3. 解析/估算 Token 数量（双轨制）
 *   4. 替换行尾动态文案为固定格式
 *   5. 构造 TurnStats 并持久化到 globalState
 *   6. 追加统计 Markdown 表格 (Feature 2)
 */
async function handleResponseEnd(payload: ResponseEndPayload): Promise<void> {
  if (!_ctx || _state !== EngineState.TIMING) {
    logWarn('[Engine] E3 received but not in TIMING state, ignoring');
    return;
  }

  _state = EngineState.FINALIZING;
  _ctx.finishStatus = TurnFinishStatus.NORMAL;

  // ── Step 1: 销毁刷新定时器 + chunk 超时检测 ──
  destroyRefreshTimer();
  clearChunkTimeout();

  // ── Step 2: 停止计时器，获取最终耗时 ──
  const finalDurationMs = stopTimer(_ctx.timer);
  const durationReadable = formatDuration(finalDurationMs);

  logInfo(
    `[Engine] E3 ⏱ TIMER_END | turn=${_ctx.turnId}` +
    ` | duration=${durationReadable}` +
    ` | responseLen=${_ctx.accumulatedResponseText.length} chars`
  );

  // ── Step 3: 计算 Token 数量（双轨制） ──
  const tokenCount = await resolveTokenCount(payload);

  logInfo(
    `[Engine] E3 📊 TOKEN_RESOLVED | turn=${_ctx.turnId}` +
    ` | prompt=${tokenCount.promptTokens}` +
    ` | completion=${tokenCount.completionTokens}` +
    ` | total=${tokenCount.totalTokens}` +
    ` | estimated=${tokenCount.isEstimated}`
  );

  // ── Step 4: 替换行尾文案为最终格式 ──
  const finalDisplay = formatRealTimeDisplay(finalDurationMs, true, {
    showTokens: true,
    promptTokens: tokenCount.promptTokens,
    completionTokens: tokenCount.completionTokens,
    ttftMs: _ctx.ttftMs > 0 ? _ctx.ttftMs : undefined,
  });

  if (_ctx.lineId) {
    replaceLineTailText(_ctx.lineId, finalDisplay.trim());
  }

  // ★ 同步更新 Webview 面板最终结果
  try { webviewSetFinalResult(finalDisplay.trim()); } catch { /* non-critical */ }

  // ── Step 5: 构造 TurnStats 并持久化 ──
  const turnStats = buildTurnStats(_ctx, finalDurationMs, durationReadable, tokenCount);
  await persistTurnStats(turnStats);

  // ── Step 6: 追加统计 Markdown 表格到聊天面板 (Feature 2) ──
  injectTurnSummaryTable(turnStats);

  logInfo(
    `[Engine] E3 ✅ TURN_COMPLETE | turn=${_ctx.turnId}` +
    ` | ${durationReadable}` +
    ` | tokens=${tokenCount.totalTokens}${tokenCount.isEstimated ? '(est)' : ''}` +
    ` | speed=${turnStats.outputSpeedCharsPerSec.toFixed(1)} chars/s` +
    ` | status=NORMAL`
  );

  // 重置状态
  resetToIdle();
}

/**
 * [E4] 处理「会话切换」事件 — 用户主动中断（新建对话 / 切换会话）
 *
 * ★ 第六阶段变更：
 *   - 旧版：不持久化数据（丢弃）
 *   - 新版：记录有效耗时 + 估算 Token → 持久化到日统计（带 INTERRUPTED 标记）
 *   - 强制清空所有 Engine 定时器（杜绝内存泄漏）
 *
 * 操作：
 *   1. 停止所有定时器和计时器
 *   2. 用已累计文本估算 Token
 *   3. 行尾标记为"已中断"
 *   4. 构造部分统计数据 → 持久化
 *   5. 输出中断状态统计表格
 */
async function handleSessionChange(): Promise<void> {
  if (_state === EngineState.IDLE || !_ctx) return;

  const activeTurn = _ctx;
  logInfo(
    `[Engine] E4 🔀 SESSION_CHANGE | turn=${activeTurn.turnId}` +
    ` | state=${_state}` +
    ` | elapsedSoFar=${formatDuration(getElapsedMs(activeTurn.timer))}`
  );
  activeTurn.finishStatus = TurnFinishStatus.INTERRUPTED;

  destroyRefreshTimer();
  clearChunkTimeout();

  // 停止计时
  const elapsedMs = stopTimer(activeTurn.timer);
  const durationReadable = formatDuration(elapsedMs);

  // 行尾文案标记为"已中断"
  if (activeTurn.lineId && _state === EngineState.TIMING) {
    const interruptedDisplay = formatRealTimeDisplay(elapsedMs, false) + ' ⚠️ 已中断';
    replaceLineTailText(activeTurn.lineId, interruptedDisplay.trim());
    try { webviewSetFinalResult(interruptedDisplay.trim()); } catch { /* non-critical */ }
  }

  // 先释放当前上下文，避免后续异步持久化与新一轮 REQUEST_START 串状态
  resetToIdle();

  // ★ 用已累计文本估算 Token（即使中断也有部分数据可记录）
  const estimatedToken = await estimatePartialTokens(activeTurn);

  // 构造统计并持久化
  const turnStats = buildTurnStats(activeTurn, elapsedMs, durationReadable, estimatedToken);
  await persistTurnStats(turnStats); // ★ 第六阶段：中断场景也持久化

  // 注入统计表格
  injectTurnSummaryTable(turnStats);

  logDebug(`[Engine] E4 completed | remaining global=${cleanupManager.size}`);

  logInfo(
    `[Engine] E4 ⚠️ TURN_INTERRUPTED | turn=${activeTurn.turnId}` +
    ` | ${durationReadable}` +
    ` | estTokens=${estimatedToken.totalTokens}` +
    ` | responseLen=${activeTurn.accumulatedResponseText.length} chars`
  );
}

/**
 * [E5] 处理「请求错误」事件 — 服务端/网络异常
 *
 * ★ 第六阶段变更：
 *   - 旧版：丢弃不完整数据，不写入存储
 *   - 新版：记录有效耗时 + 已接收到的文本估算 Token → 持久化（带 ERROR 标记）
 *   - 强制清空所有 Engine 定时器
 *
 * 操作：
 *   1. 停止计时
 *   2. 用已累计文本估算 Token
 *   3. 行尾标记"请求失败"
 *   4. 构造部分统计数据 → 持久化
 *   5. 输出错误状态统计表格
 */
async function handleRequestError(payload: RequestErrorPayload): Promise<void> {
  if (_state === EngineState.IDLE || !_ctx) return;

  const activeTurn = _ctx;
  const errMsg = String(payload.error ?? 'Unknown error');
  logWarn(
    `[Engine] E5 ❌ REQUEST_ERROR | turn=${activeTurn.turnId}` +
    ` | error=${errMsg}` +
    ` | state=${_state}`
  );
  activeTurn.finishStatus = TurnFinishStatus.ERROR;

  destroyRefreshTimer();
  clearChunkTimeout();

  // 停止计时
  const elapsedMs = stopTimer(activeTurn.timer);
  const durationReadable = formatDuration(elapsedMs);

  // 行尾文案标记
  if (activeTurn.lineId && _state === EngineState.TIMING) {
    const errorDisplay = formatRealTimeDisplay(elapsedMs, false) + ' ❌ 请求失败';
    replaceLineTailText(activeTurn.lineId, errorDisplay.trim());
    try { webviewSetFinalResult(errorDisplay.trim()); } catch { /* non-critical */ }
  }

  // 先释放当前上下文，避免后续异步持久化与新一轮事件串状态
  resetToIdle();

  // ★ 用已累计文本估算 Token（即使失败也有部分数据）
  const estimatedToken = await estimatePartialTokens(activeTurn);

  // 构造统计并持久化
  const turnStats = buildTurnStats(activeTurn, elapsedMs, durationReadable, estimatedToken);
  await persistTurnStats(turnStats);

  // 注入统计表格
  injectTurnSummaryTable(turnStats);

  logDebug(`[Engine] E5 completed | remaining global=${cleanupManager.size}`);

  logInfo(
    `[Engine] E5 ❌ TURN_ERROR | turn=${activeTurn.turnId}` +
    ` | ${durationReadable}` +
    ` | estTokens=${estimatedToken.totalTokens}` +
    ` | responseLen=${activeTurn.accumulatedResponseText.length} chars` +
    ` | error=${errMsg}`
  );
}

// ══════════════════════════════════════════════════════
// Feature 3: /sum 日汇总命令处理
// ══════════════════════════════════════════════════════

/**
 * 处理 /sum 命令 — 输出当日全日对话统计总表
 *
 * 流程：
 *   1. 从 globalState 读取当日累计统计数据
 *   2. 无数据 → 友好提示「今日暂无对话统计数据」
 *   3. 有数据 → 渲染标准 Markdown 汇总表（主表 + 明细 + 时间戳）
 *   4. 通过 appendMarkdownTable 注入聊天面板
 *
 * 统计字段：
 *   当日对话总轮次 / 合计总耗时 / 平均响应速度
 *   总输入 Token / 总输出 Token / 合计总消耗 Token
 */
async function handleSumCommand(): Promise<void> {
  if (!_extensionCtx) {
    logWarn('[Engine] /sum called but engine not initialized');
    return;
  }

  const todayStr = getTodayStr();
  logInfo(`[Engine] /sum triggered | date=${todayStr}`);

  try {
    // ── Step 1: 从 globalState 读取当日累计统计数据 ──
    const { readTodayStats } = await import('../storage/storageManager');
    const dailyData = await readTodayStats(_extensionCtx);

    logInfo(
      `[Engine] /sum DATA_LOADED | turns=${dailyData.totalTurns}` +
      ` | duration=${formatDuration(dailyData.totalDurationMs)}`
    );

    // ── Step 2: 无数据友好提示 ──
    if (!dailyData.turns || dailyData.totalTurns === 0) {
      const emptyMsg = `\n\n### 📊 CodeBuddy 日统计 — ${todayStr}\n\n${EMPTY_DAY_MESSAGE}\n`;
      appendMarkdownTable(emptyMsg);
      logInfo('[Engine] /sum → empty day prompt shown');
      return;
    }

    // ── Step 3: 有数据 → 渲染完整统计 Markdown ──
    const { generateDailySummaryTable, generateTurnDetailTable } =
      await import('../renderer/summaryTable');

    const summaryMd = generateDailySummaryTable(dailyData, { titleDate: todayStr });

    let detailMd = '';
    if (dailyData.turns.length > 0) {
      detailMd = '\n\n#### 📋 各轮次明细\n\n' + generateTurnDetailTable(dailyData);
    }

    const footer = `\n\n> ⏰ 数据更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    const fullOutput = summaryMd + detailMd + footer;

    appendMarkdownTable(fullOutput);

    logInfo(
      `[Engine] /sum ✅ SUMMARY_RENDERED | turns=${dailyData.totalTurns}` +
      ` | duration=${formatDuration(dailyData.totalDurationMs)}` +
      ` | tokens=${dailyData.totalTokens.toLocaleString()}` +
      ` | avgSpeed=${dailyData.avgOutputSpeedCharsPerSec.toFixed(1)} chars/s`
    );
  } catch (e) {
    logError('[Engine] /sum execution failed', e);
    const errorMsg = '\n\n> ❌ 统计数据加载失败，请稍后重试。';
    try { appendMarkdownTable(errorMsg); } catch { /* ignore */ }
  }
}

/** 空数据提示文案 */
const EMPTY_DAY_MESSAGE =
  '> 💡 **今日暂无对话统计数据**\n>\n> 开始与 AI 对话后，此处将展示当日累计的耗时、Token 消耗等统计信息。';

// ══════════════════════════════════════════════════════
// 内部辅助方法
// ══════════════════════════════════════════════════════

/**
 * Token 数量解析（双轨制：接口优先 → tiktoken fallback）
 */
async function resolveTokenCount(payload: ResponseEndPayload): Promise<TokenCount> {
  // 优先：从大模型接口 usage 字段读取
  const apiResult = parseUsageFromAPI(payload.finalUsage);
  if (apiResult && !apiResult.isEstimated) {
    logDebug('[Engine] Token resolved from API usage field');
    return apiResult;
  }

  // Fallback：使用 tiktoken 本地估算
  if (!_ctx) {
    logWarn('[Engine] No active context for token fallback, returning zeros');
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: true };
  }

  try {
    const localResult = await estimateTokensLocally(
      payload.userMessage || _ctx.userMessage,
      payload.fullResponseText || ''
    );
    logDebug('[Engine] Token resolved via tiktoken estimation');
    return localResult;
  } catch (e) {
    logError('[Engine] Token fallback estimation failed, using zero values', e);
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: true };
  }
}

/**
 * ★ 第六阶段新增：对中断/错误场景进行 Token 估算
 *
 * 当对话非正常结束时（INTERRUPTED / ERROR），API usage 字段不可用，
 * 但我们已经累计了部分 AI 回复文本，可以用它来做粗略估算：
 *   - completion ≈ accumulatedResponseText.length / 3~4 （中文约 1-2 字符/token，英文约 4 字符/token）
 *   - prompt 无法估算（用户消息始终可用），设为 0
 *
 * @param ctx 当前活跃轮次上下文
 * @returns 估算的 TokenCount（isEstimated=true）
 */
async function estimatePartialTokens(ctx: ActiveTurnContext): Promise<TokenCount> {
  const responseLen = ctx.accumulatedResponseText.length;
  if (responseLen === 0) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: true };
  }

  try {
    // 尝试用 tiktoken 精确估算已有文本
    const result = await estimateTokensLocally(ctx.userMessage, ctx.accumulatedResponseText);
    logDebug(
      `[Engine] Partial token estimated | responseLen=${responseLen}` +
      ` | tokens=${result.totalTokens}`
    );
    return result;
  } catch {
    // tiktoken 不可用时用粗糙比例估算
    const roughEstimate = Math.ceil(responseLen / 3.5);
    logDebug(
      `[Engine] Rough partial token estimate | responseLen=${responseLen}` +
      ` | estTokens≈${roughEstimate}`
    );
    return {
      promptTokens: 0,
      completionTokens: roughEstimate,
      totalTokens: roughEstimate,
      isEstimated: true,
    };
  }
}

/** 构造 TurnStats 数据对象 */
function buildTurnStats(ctx: ActiveTurnContext, durationMs: number, durationReadable: string, tokenCount: TokenCount): TurnStats {
  const responseLen = ctx.accumulatedResponseText.length;
  const durationSec = Math.max(0.001, durationMs / 1000);
  const outputSpeed = responseLen / durationSec;

  return {
    turnId: ctx.turnId,
    startTime: ctx.startTimeISO,
    endTime: getNowISO(),
    durationMs,
    durationReadable,
    tokenCount,
    userMessagePreview: truncatePreview(ctx.userMessage),
    ttftMs: ctx.ttftMs,
    ttftReadable: formatDuration(ctx.ttftMs),
    responseLength: responseLen,
    outputSpeedCharsPerSec: outputSpeed,
    finishStatus: ctx.finishStatus,
  };
}

/** 截断用户消息预览文本 */
function truncatePreview(msg: string, maxLen: number = 50): string {
  if (!msg) return '';
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen) + '...';
}

/**
 * 持久化单轮统计数据
 *
 * ★ 第六阶段变更：
 *   - 旧版：仅 NORMAL 状态持久化
 *   - 新版：NORMAL / INTERRUPTED / ERROR 三种状态均持久化
 *   - 通过 finishStatus 字段区分，下游展示层根据状态调整 UI 展示
 */
async function persistTurnStats(turn: TurnStats): Promise<void> {
  if (!_extensionCtx) return;

  try {
    await appendTurnStats(_extensionCtx!, turn);
    logInfo(
      `[Engine] 💾 PERSISTED | turn=${turn.turnId}` +
      ` | status=${turn.finishStatus}` +
      ` | duration=${turn.durationMs}ms` +
      ` | tokens=${turn.tokenCount.totalTokens}`
    );
  } catch (e) {
    logError('[Engine] Failed to persist turn stats', e);
  }
}

/**
 * 向聊天面板注入本轮统计 Markdown 表格 (Feature 2)
 *
 * 三种结束场景均调用此方法，通过 statusTag 区分：
 *   - NORMAL:     完整统计 + ✅
 *   - INTERRUPTED: 部分统计 + ⚠️ 已中断（数据可能不完整但已持久化）
 *   - ERROR:      部分统计 + ❌ 错误（已持久化供参考）
 */
function injectTurnSummaryTable(turn: TurnStats): void {
  try {
    const md = generateTurnSummaryTable(turn);

    let statusTag = '';
    switch (turn.finishStatus) {
      case TurnFinishStatus.NORMAL:
        statusTag = '\n\n> ✅ 本轮对话正常完成';
        break;
      case TurnFinishStatus.INTERRUPTED:
        statusTag = '\n\n> ⚠️ 本轮对话被中断（数据已记录，部分字段为估算值）';
        break;
      case TurnFinishStatus.ERROR:
        statusTag = '\n\n> ❌ 本轮对话因请求错误终止（已记录部分数据）';
        break;
    }

    appendMarkdownTable(md + statusTag);

    // ★ 同步注入 Webview 面板统计表格
    try { webviewAppendMarkdown(md + statusTag); } catch { /* non-critical */ }

    logInfo(`[Engine] Feature2 Table injected | status=${turn.finishStatus}`);
  } catch (e) {
    logError('Failed to inject turn summary table', e);
  }
}

/** 销毁刷新定时器 */
function destroyRefreshTimer(): void {
  if (_ctx?.refreshTimerId != null) {
    clearInterval(_ctx.refreshTimerId);
    _ctx.refreshTimerId = null;
    logDebug(`[Engine] Refresh timer destroyed for turn=${_ctx?.turnId ?? '?'}`);
  }
}

/** 强制停止当前轮次（用于异常恢复 / 新对话覆盖） */
function forceStopCurrentTurn(): void {
  if (_ctx) {
    logDebug(`[Engine] Force stopping turn=${_ctx.turnId} | state=${_state}`);
  }
  destroyRefreshTimer();
  clearChunkTimeout();
  if (_ctx?.timer) {
    try { stopTimer(_ctx.timer); } catch { /* ignore */ }
  }
  resetToIdle();
}

/** 重置引擎到空闲状态 */
function resetToIdle(): void {
  _ctx = null;
  _state = EngineState.IDLE;
  _lastDisplayedMs = -1;
  _lastDisplayStr = '';
}
