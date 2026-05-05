/**
 * 配置项类型定义
 *
 * 性能优化说明：
 *   - timerRefreshInterval: 200ms（原 100ms）
 *     降低 DOM 刷新频率，兼顾实时感与渲染性能
 *     人类感知 ~100ms 即可察觉变化，200ms 足够流畅且减少 50% 渲染开销
 *   - autoCleanupDays: 30 天默认保留
 */

export interface EnhanceConfig {
  /** 行尾计时刷新间隔 ms（推荐 150~300） */
  timerRefreshInterval: number;
  /** 显示模式：inline（行内） / statusbar（状态栏） */
  displayMode: 'inline' | 'statusbar';
  /** 是否启用 tiktoken 本地估算 fallback */
  enableTiktokenFallback: boolean;
  /** 用户消息预览截断长度 */
  previewTruncateLength: number;
  /** 自动清理 N 天前的历史数据（0 = 不自动清理） */
  autoCleanupDays: number;
}

export const DEFAULT_CONFIG: EnhanceConfig = {
  /** ★ 第六阶段优化：从 100ms → 200ms，兼顾实时感与性能 */
  timerRefreshInterval: 200,
  displayMode: 'inline',
  enableTiktokenFallback: true,
  previewTruncateLength: 50,
  autoCleanupDays: 30,
};
