/**
 * EventHookManager — 事件钩子管理器（核心桥梁）
 *
 * 职责：
 *   1. 管理所有生命周期事件的订阅与分发（EventEmitter 模式）
 *   2. 提供 emit/dispatch 方法供外部触发事件
 *   3. 统一管理 listener 清理，防止内存泄漏
 *   4. 作为 CodeBuddy 内部事件 与 Engine 主引擎 之间的解耦层
 */

import { EventEmitter } from 'events';
import {
  ChatLifecycleEvent,
  RequestStartPayload,
  StreamChunkPayload,
  ResponseEndPayload,
  RequestErrorPayload,
} from '../types/events';
import { logError, logInfo } from '../utils/errorGuard';
import { disposeAllTimers, safeSetTimeout, registerTimer } from '../utils/cleanup';

// ─── 类型定义 ───────────────────────────────────────

/** 通用事件监听器类型 */
export type Listener<T = unknown> = (payload: T) => void;

/** 钩子管理器配置 */
export interface HookManagerConfig {
  /** 最大允许的监听器数量（防泄漏检测） */
  maxListeners?: number;
}

// ─── 事件钩子管理器 ─────────────────────────────────

class _EventHookManager extends EventEmitter {
  private _isDisposed = false;

  constructor(config?: HookManagerConfig) {
    super({ captureRejections: true });
    if (config?.maxListeners) {
      this.setMaxListeners(config.maxListeners);
    }
  }

  // ═══════════════════════════════════════════════════
  // 便捷注册方法 — 强类型事件绑定
  // ═══════════════════════════════════════════════════

  /** 监听对话开始 */
  onRequestStart(listener: Listener<RequestStartPayload>): this {
    return this.on(ChatLifecycleEvent.REQUEST_START, listener);
  }

  /** 监听流式输出 chunk */
  onStreamChunk(listener: Listener<StreamChunkPayload>): this {
    return this.on(ChatLifecycleEvent.STREAM_CHUNK, listener);
  }

  /** 监听对话结束 */
  onResponseEnd(listener: Listener<ResponseEndPayload>): this {
    return this.on(ChatLifecycleEvent.RESPONSE_END, listener);
  }

  /** 监听会话切换 */
  onSessionChange(listener: Listener<void>): this {
    return this.on(ChatLifecycleEvent.SESSION_CHANGE, listener);
  }

  /** 监听请求错误 */
  onRequestError(listener: Listener<RequestErrorPayload>): this {
    return this.on(ChatLifecycleEvent.REQUEST_ERROR, listener);
  }

  // ═══════════════════════════════════════════════════
  // 触发方法（供外部调用）
  // ═══════════════════════════════════════════════════

  /** 发出「对话开始」事件 */
  emitRequestStart(payload: RequestStartPayload): boolean {
    logInfo('EventHook: REQUEST_START', payload.requestId);
    return this.emit(ChatLifecycleEvent.REQUEST_START, payload);
  }

  /** 发出「流式 chunk」事件 */
  emitStreamChunk(payload: StreamChunkPayload): boolean {
    return this.emit(ChatLifecycleEvent.STREAM_CHUNK, payload);
  }

  /** 发出「对话结束」事件 */
  emitResponseEnd(payload: ResponseEndPayload): boolean {
    logInfo('EventHook: RESPONSE_END');
    return this.emit(ChatLifecycleEvent.RESPONSE_END, payload);
  }

  /** 发出「会话切换」事件 */
  emitSessionChange(): boolean {
    logInfo('EventHook: SESSION_CHANGE');
    return this.emit(ChatLifecycleEvent.SESSION_CHANGE);
  }

  /** 发出「请求错误」事件 */
  emitRequestError(payload: RequestErrorPayload): boolean {
    logInfo('EventHook: REQUEST_ERROR');
    return this.emit(ChatLifecycleEvent.REQUEST_ERROR, payload);
  }

  // ═══════════════════════════════════════════════════
  // 生命周期管理
  // ═══════════════════════════════════════════════════

  /** 移除指定事件的全部监听器 */
  offAll(event: ChatLifecycleEvent): void {
    this.removeAllListeners(event);
  }

  /** 完全销毁：移除全部监听器 + 停止内部定时器 + 标记已释放 */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.removeAllListeners();
    disposeAllTimers();
    logInfo('EventHookManager disposed');
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }
}

/** 全局单例：事件钩子管理器 */
export const eventHookManager = new _EventHookManager({ maxListeners: 20 });
