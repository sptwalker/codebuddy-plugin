/**
 * 容错包装器 + 结构化日志系统
 *
 * 日志级别：
 *   DEBUG   — 调试信息（定时器刷新、chunk 累计等高频节点）
 *   INFO    — 关键业务节点（计时开始/结束、命令触发、数据存储）
 *   WARN    — 异常状态但可恢复（状态机容错、跨日检测）
 *   ERROR   — 严重错误（存储失败、注入失败）
 *
 * 输出通道：VS Code OutputChannel "CodeBuddy Enhance" + Console
 */

import * as vscode from 'vscode';

// ─── 日志级别枚举 ──────────────────────────────────────

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/** 全局日志级别阈值（低于此级别的不输出） */
let _logLevelThreshold: LogLevel = LogLevel.DEBUG;

/**
 * 设置日志级别阈值
 * @param level 最低输出级别
 */
export function setLogLevel(level: LogLevel): void {
  _logLevelThreshold = level;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

// ─── VS Code 输出通道 ──────────────────────────────────

let _outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('CodeBuddy Enhance');
  }
  return _outputChannel;
}

/**
 * 初始化输出通道（在 activate 中调用）
 */
export function initOutputChannel(): void {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('CodeBuddy Enhance');
  }
}

/**
 * 销毁输出通道（在 deactivate 中调用）
 */
export function disposeOutputChannel(): void {
  if (_outputChannel) {
    _outputChannel.dispose();
    _outputChannel = undefined;
  }
}

// ─── 核心日志方法 ──────────────────────────────────────

/**
 * 统一日志输出函数
 *
 * 格式: [YYYY-MM-DDTHH:mm:ss.sssZ] [CodeBuddy Enhance] [LEVEL] message [data]
 *
 * @param level   日志级别
 * @param message 日志消息
 * @param data    附加数据（可选）
 */
function emitLog(level: LogLevel, message: string, data?: unknown): void {
  // 级别过滤
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_logLevelThreshold]) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [CodeBuddy Enhance] [${level}]`;
  const fullMsg = `${prefix} ${message}`;
  const dataStr = data !== undefined ? ` ${typeof data === 'string' ? data : JSON.stringify(data)}` : '';

  // 控制台输出
  switch (level) {
    case LogLevel.ERROR:
      console.error(fullMsg, data ?? '');
      break;
    case LogLevel.WARN:
      console.warn(fullMsg, data ?? '');
      break;
    case LogLevel.DEBUG:
      console.debug(fullMsg, data ?? '');
      break;
    default:
      console.log(fullMsg, data ?? '');
  }

  // VS Code 输出通道（仅 WARN 和以上写入通道，避免刷屏）
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[LogLevel.WARN]) {
    try {
      getOutputChannel().appendLine(`${fullMsg}${dataStr}`);
    } catch { /* ignore */ }
  }
}

// ─── 便捷导出（对外 API）──────────────────────────────

export function logDebug(message: string, data?: unknown): void {
  emitLog(LogLevel.DEBUG, message, data);
}

export function logInfo(message: string, data?: unknown): void {
  emitLog(LogLevel.INFO, message, data);
}

export function logWarn(message: string, data?: unknown): void {
  emitLog(LogLevel.WARN, message, data);
}

export function logError(message: string, data?: unknown): void {
  emitLog(LogLevel.ERROR, message, data);
}

/**
 * 计时器专用日志（DEBUG 级别，带节流）
 * 用于高频定时器刷新场景，避免日志刷屏
 */
let _lastTimerLogMs = 0;
const TIMER_LOG_THROTTLE_MS = 5000; // 同一 turn 最多每 5 秒打一次计时日志

export function logTimerDebug(turnId: string, elapsedMs: number): void {
  const now = Date.now();
  if (now - _lastTimerLogMs < TIMER_LOG_THROTTLE_MS) return;
  _lastTimerLogMs = now;
  emitLog(LogLevel.DEBUG, `[Timer] turn=${turnId} | elapsed=${elapsedMs.toFixed(0)}ms`);
}

// ─── 容错包装器 ────────────────────────────────────────

/**
 * 同步容错包装器 — 执行失败返回默认值，不抛异常
 */
export function guardSync<T>(fn: () => T, fallback: T, context?: string): T {
  try {
    return fn();
  } catch (e) {
    logError(`guardSync failed${context ? ` [${context}]` : ''}`, e);
    return fallback;
  }
}

/**
 * 异步容错包装器 — 执行失败返回默认值，不 reject
 */
export async function guardAsync<T>(fn: () => Promise<T>, fallback: T, context?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    logError(`guardAsync failed${context ? ` [${context}]` : ''}`, e);
    return fallback;
  }
}
