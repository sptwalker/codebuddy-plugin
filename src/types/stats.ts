/**
 * 统计数据类型定义
 */

/** 单次 Token 计数结果 */
export interface TokenCount {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  isEstimated: boolean;
}

/** 单轮对话的完成状态 */
export enum TurnFinishStatus {
  /** 正常完成 */
  NORMAL = 'normal',
  /** 用户中断（会话切换/手动停止） */
  INTERRUPTED = 'interrupted',
  /** 请求失败（网络错误/服务端错误） */
  ERROR = 'error',
}

/** 单轮对话的完整统计数据 */
export interface TurnStats {
  turnId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  durationReadable: string;
  tokenCount: TokenCount;
  userMessagePreview: string;
  /** 首个 Token 延迟时间 ms (TTFT: Time To First Token) = 从请求发出到首个 chunk 到达 */
  ttftMs: number;
  /** TTFT 可读格式字符串 */
  ttftReadable: string;
  /** AI 回复文本字符数 */
  responseLength: number;
  /** 平均流式输出速率 (字符/秒), = responseLength / (durationMs / 1000) */
  outputSpeedCharsPerSec: number;
  /** 本轮结束状态 */
  finishStatus: TurnFinishStatus;
}

/** 单日所有对话的聚合桶 */
export interface DailyStats {
  date: string;
  turns: TurnStats[];
  totalTurns: number;
  totalDurationMs: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** 当日累计 TTFT 总和 ms */
  totalTtftMs: number;
  /** 当日平均 TTFT ms */
  avgTtftMs: number;
  /** 当日累计 AI 回复总字符数 */
  totalResponseLength: number;
  /** 当日平均流式输出速率 (chars/sec) */
  avgOutputSpeedCharsPerSec: number;
}

/** GlobalState 存储的根结构 */
export interface EnhancedStatsRoot {
  version: string;
  dailyBuckets: Record<string, DailyStats>;
}

export const STORAGE_ROOT_KEY = 'codebuddy.enhance.stats';
export const SCHEMA_VERSION = '1.0.0';

/** 创建空的根数据结构 */
export function createEmptyRoot(): EnhancedStatsRoot {
  return {
    version: SCHEMA_VERSION,
    dailyBuckets: {},
  };
}
