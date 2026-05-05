/**
 * 定时器/资源全局管理器
 * 统一管理所有 setInterval / setTimeout，防止内存泄漏
 *
 * 核心能力：
 *   1. 全局定时器注册池（自动追踪）
 *   2. 一键清理（deactivate / session change / new conversation 时调用）
 *   3. 统计信息（调试用：当前活跃定时器数量、历史峰值）
 *   4. 分类标记（区分 refreshTimer / delayTimer / cleanupTimer）
 */

type TimerId = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/** 定时器分类标签 */
export enum TimerTag {
  /** 引擎刷新定时器（setInterval 行尾时间更新） */
  ENGINE_REFRESH = 'engine:refresh',
  /** 延迟执行定时器（setTimeout 延迟任务） */
  DELAY = 'delay',
  /** 清理/回收定时器 */
  CLEANUP = 'cleanup',
  /** 其他 */
  OTHER = 'other',
}

interface TimerEntry {
  id: TimerId;
  tag: TimerTag;
  createdAt: number;
  description?: string;
}

class CleanupManager {
  private entries: Map<TimerId, TimerEntry> = new Map();
  private _peakSize = 0;

  /** 注册一个需要追踪的定时器（手动注册） */
  register(id: TimerId, tag: TimerTag = TimerTag.OTHER, desc?: string): TimerId {
    this.entries.set(id, { id, tag, createdAt: Date.now(), description: desc });
    this._updatePeak();
    return id;
  }

  /** 包装 setTimeout，自动追踪 */
  setTimeout(callback: (...args: unknown[]) => void, ms?: number, tag: TimerTag = TimerTag.DELAY, desc?: string): TimerId {
    const id = setTimeout(() => {
      this.entries.delete(id);
      callback();
    }, ms ?? 0);
    this.entries.set(id, { id, tag, createdAt: Date.now(), description: desc });
    this._updatePeak();
    return id;
  }

  /** 包装 setInterval，自动追踪 */
  setInterval(callback: (...args: unknown[]) => void, ms?: number, tag: TimerTag = TimerTag.OTHER, desc?: string): TimerId {
    const id = setInterval(callback, ms);
    this.entries.set(id, { id, tag, createdAt: Date.now(), description: desc });
    this._updatePeak();
    return id;
  }

  /** 清除单个定时器（同时从追踪池移除） */
  clearTimer(id: TimerId): boolean {
    if (!this.entries.has(id)) return false;
    try {
      clearTimeout(id);
      clearInterval(id);
    } catch { /* ignore */ }
    this.entries.delete(id);
    return true;
  }

  /**
   * 清除所有已注册的定时器
   *
   * 调用场景：
   *   - deactivate 插件失活
   *   - 会话切换 (E4 SESSION_CHANGE)
   *   - 新建对话 (E1 容错强制停止上一轮)
   *   - 请求错误后恢复 (E5 后)
   *
   * @param tag 可选：仅清除指定分类的定时器；不传则清除全部
   * @returns 清除的定时器数量
   */
  disposeAll(tag?: TimerTag): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (tag !== undefined && entry.tag !== tag) continue;
      try {
        clearTimeout(id);
        clearInterval(id);
      } catch { /* ignore */ }
      this.entries.delete(id);
      count++;
    }
    return count;
  }

  /** 强制销毁所有 Engine 相关定时器（session change / new conversation） */
  disposeEngineTimers(): number {
    return this.disposeAll(TimerTag.ENGINE_REFRESH);
  }

  // ─── 统计信息 ────────────────────────────────────────

  /** 当前追踪的定时器总数 */
  get size(): number {
    return this.entries.size;
  }

  /** 历史峰值数量 */
  get peakSize(): number {
    return this._peakSize;
  }

  /** 按分类统计数量 */
  getCountByTag(tag: TimerTag): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.tag === tag) count++;
    }
    return count;
  }

  /** 获取所有活跃定时器的描述列表（调试用） */
  getDebugInfo(): string[] {
    const lines: string[] = [`[CleanupManager] active=${this.size} peak=${this._peakSize}`];
    for (const entry of this.entries.values()) {
      const ageMs = Date.now() - entry.createdAt;
      lines.push(
        `  ${entry.tag} | age=${(ageMs / 1000).toFixed(1)}s` +
        (entry.description ? ` | ${entry.description}` : '')
      );
    }
    return lines;
  }

  // ─── 内部 ────────────────────────────────────────────

  private _updatePeak(): void {
    if (this.entries.size > this._peakSize) {
      this._peakSize = this.entries.size;
    }
  }
}

// ─── 全局单例 ──────────────────────────────────────────

/** 全局清理管理器单例 */
export const cleanupManager = new CleanupManager();

// ─── 便捷导出（保持向后兼容）──────────────────────────

export const registerTimer = (id: TimerId, desc?: string) => cleanupManager.register(id, TimerTag.OTHER, desc);
export const safeSetTimeout = (cb: () => void, ms?: number) => cleanupManager.setTimeout(cb, ms, TimerTag.DELAY);
export const safeSetInterval = (cb: () => void, ms?: number) => cleanupManager.setInterval(cb, ms, TimerTag.OTHER);
/** 注册引擎刷新定时器（带 ENGINE_REFRESH 标签，便于批量清理） */
export const safeSetIntervalForEngine = (cb: () => void, ms?: number, turnId?: string) =>
  cleanupManager.setInterval(cb, ms, TimerTag.ENGINE_REFRESH, `refresh:${turnId}`);
export const disposeAllTimers = () => cleanupManager.disposeAll();
export const disposeEngineTimersOnly = () => cleanupManager.disposeEngineTimers();
