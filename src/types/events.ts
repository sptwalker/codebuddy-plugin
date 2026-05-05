/**
 * 事件类型定义
 */

export enum ChatLifecycleEvent {
  REQUEST_START = 'codebuddy.enhance.requestStart',
  STREAM_CHUNK = 'codebuddy.enhance.streamChunk',
  RESPONSE_END = 'codebuddy.enhance.responseEnd',
  SESSION_CHANGE = 'codebuddy.enhance.sessionChange',
  REQUEST_ERROR = 'codebuddy.enhance.requestError',
}

export interface RequestStartPayload {
  timestamp: number;
  userMessage: string;
  requestId: string;
}

export interface StreamChunkPayload {
  chunk: string;
  chunkIndex: number;
  /** 当前 chunk 到达时刻的 performance.now() 时间戳（用于计算 TTFT） */
  timestamp?: number;
  usageSnapshot?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface ResponseEndPayload {
  finalUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
  fullResponseText?: string;
  userMessage?: string;
}

export interface RequestErrorPayload {
  error: Error | string;
  partialData?: Partial<TurnStats>;
}
