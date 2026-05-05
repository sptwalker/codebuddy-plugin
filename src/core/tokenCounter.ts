/**
 * Token 统计工具
 * 优先读取大模型接口返回的 usage 字段；
 * 无数据时基于 tiktoken 本地编码计算文本 Token 数量（fallback）
 */

import type { TokenCount } from '../types/stats';
import { logError, guardSync } from '../utils/errorGuard';

// ─── tiktoken 动态导入缓存 ────────────────────────────────
let tiktokenEncode: ((text: string) => ArrayLike<number>) | null = null;
let tiktokenLoadPromise: Promise<boolean> | null = null;

/**
 * 异步初始化 tiktoken 编码器（懒加载）
 * 只在需要 fallback 时才加载，避免影响启动性能
 */
async function initTiktoken(): Promise<boolean> {
  if (tiktokenEncode) return true;
  if (tiktokenLoadPromise) return tiktokenLoadPromise;

  tiktokenLoadPromise = (async () => {
    try {
      // 动态 import tiktoken，避免不需要时占用内存
      const tiktokenModule = await import('tiktoken');
      const encoding = await tiktokenModule.encoding_for_model('gpt-4o');
      tiktokenEncode = (text: string) => encoding.encode(text);
      return true;
    } catch (e) {
      logError('Failed to initialize tiktoken fallback', e);
      tiktokenEncode = null;
      return false;
    }
  })();

  return tiktokenLoadPromise;
}

/**
 * 从大模型接口 usage 字段解析 Token 数
 *
 * @param usage - 接口返回的 usage 对象，格式如:
 *   { prompt_tokens: number; completion_tokens: number; total_tokens?: number }
 * @returns TokenCount 或 null（表示无可用接口数据）
 */
export function parseUsageFromAPI(usage?: {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}): TokenCount | null {
  if (
    !usage ||
    (usage.prompt_tokens == null && usage.completion_tokens == null)
  ) {
    return null;
  }

  const pt = Number(usage.prompt_tokens ?? 0);
  const ct = Number(usage.completion_tokens ?? 0);

  return {
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: pt + ct,
    isEstimated: false,
  };
}

/**
 * 使用 tiktoken 本地估算文本 Token 数（fallback 方案）
 *
 * @param userMessage   用户输入消息
 * @param assistantReply AI 回复内容
 * @returns Promise<TokenCount> 估算结果
 */
export async function estimateTokensLocally(
  userMessage: string,
  assistantReply: string
): Promise<TokenCount> {
  const ready = await initTiktoken();
  if (!ready || !tiktokenEncode) {
    // tiktoken 不可用 → 粗略估算：按英文 ~4字符/token, 中文 ~1.5字符/token
    return roughEstimate(userMessage, assistantReply);
  }

  try {
    const promptTokens = tiktokenEncode(userMessage).length;
    const completionTokens = tiktokenEncode(assistantReply).length;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      isEstimated: true,
    };
  } catch (e) {
    logError('tiktoken encode error, falling back to rough estimate', e);
    return roughEstimate(userMessage, assistantReply);
  }
}

/**
 * 同步版本的本地估算（如果 tiktoken 已初始化则直接使用，否则粗略估算）
 */
export function estimateTokensSync(
  userMessage: string,
  assistantReply: string
): TokenCount {
  if (tiktokenEncode) {
    try {
      const promptTokens = tiktokenEncode(userMessage).length;
      const completionTokens = tiktokenEncode(assistantReply).length;
      return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        isEstimated: true,
      };
    } catch { /* fallthrough */ }
  }
  return roughEstimate(userMessage, assistantReply);
}

/**
 * 粗略估算：按字符比例折算 token（tiktoken 完全不可用时的兜底）
 * 规则：ASCII 字符 ~4字符/token，非 ASCII（中日韩等）~1.5字符/token
 */
function roughEstimate(userMsg: string, reply: string): TokenCount {
  const countTokens = (text: string): number => {
    if (!text) return 0;
    let ascii = 0;
    let nonAscii = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) <= 127) ascii++;
      else nonAscii++;
    }
    return Math.ceil(ascii / 4) + Math.ceil(nonAscii / 1.5);
  };

  const pTok = countTokens(userMsg);
  const cTok = countTokens(reply);
  return {
    promptTokens: pTok,
    completionTokens: cTok,
    totalTokens: pTok + cTok,
    isEstimated: true,
  };
}
