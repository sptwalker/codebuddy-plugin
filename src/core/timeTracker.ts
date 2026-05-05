/**
 * 高精度计时器工具
 * 基于 performance.now() 实现毫秒级精确计时
 * 支持开始、暂停、恢复、停止、格式化输出
 */

export interface TimerState {
  /** 是否正在计时中 */
  isRunning: boolean;
  /** 开始时刻的 performance.now() 值 */
  startTime: number;
  /** 已累积的耗时 (ms)，用于 pause/resume 场景 */
  accumulatedMs: number;
  /** 最后一次 stop/freeze 时的总耗时 */
  finalMs: number;
}

/** 创建一个新的计时器实例 */
export function createTimer(): TimerState {
  return {
    isRunning: false,
    startTime: 0,
    accumulatedMs: 0,
    finalMs: 0,
  };
}

/**
 * 开始 / 重新开始计时
 * @param timer 计时器状态对象
 */
export function startTimer(timer: TimerState): void {
  timer.isRunning = true;
  timer.startTime = performance.now();
  timer.accumulatedMs = 0;
  timer.finalMs = 0;
}

/**
 * 暂停计时（累积已计时间）
 * @param timer 计时器状态对象
 * @return 当前已累积的毫秒数
 */
export function pauseTimer(timer: TimerState): number {
  if (!timer.isRunning) {
    return timer.accumulatedMs + timer.finalMs;
  }
  const elapsed = performance.now() - timer.startTime;
  timer.accumulatedMs += elapsed;
  timer.isRunning = false;
  return timer.accumulatedMs;
}

/**
 * 恢复计时（从暂停点继续）
 * @param timer 计时器状态对象
 */
export function resumeTimer(timer: TimerState): void {
  if (timer.isRunning) return;
  timer.startTime = performance.now();
  timer.isRunning = true;
}

/**
 * 停止计时，固化最终耗时
 * @param timer 计时器状态对象
 * @return 最终总耗时 (ms)
 */
export function stopTimer(timer: TimerState): number {
  let totalMs = timer.accumulatedMs;
  if (timer.isRunning) {
    totalMs += performance.now() - timer.startTime;
  }
  timer.isRunning = false;
  timer.finalMs = totalMs;
  timer.accumulatedMs = 0;
  timer.startTime = 0;
  return totalMs;
}

/**
 * 获取当前已耗时间（不停止计时）
 * @param timer 计时器状态对象
 * @return 当前毫秒数
 */
export function getElapsedMs(timer: TimerState): number {
  if (!timer.isRunning) {
    return timer.accumulatedMs + timer.finalMs;
  }
  return timer.accumulatedMs + (performance.now() - timer.startTime);
}

/**
 * 将毫秒数格式化为可读字符串
 * - < 1000ms → "123.4ms"
 * - < 60000ms → "3.2s"
 * - >= 60000ms → "1m 23.4s"
 *
 * @param ms 毫秒数
 * @param decimals 小数位位数，默认 1
 */
export function formatDuration(ms: number, decimals: number = 1): string {
  if (ms < 1000) {
    return `${ms.toFixed(decimals)}ms`;
  } else if (ms < 60_000) {
    const sec = ms / 1000;
    return `${sec.toFixed(decimals)}s`;
  } else {
    const minutes = Math.floor(ms / 60_000);
    const remainSec = (ms % 60_000) / 1000;
    return `${minutes}m ${remainSec.toFixed(decimals)}s`;
  }
}

/**
 * 快捷方法：创建并立即启动一个计时器
 */
export function startNewTimer(): TimerState {
  const t = createTimer();
  startTimer(t);
  return t;
}
