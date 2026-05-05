/**
 * ChatLifecycleHook — CodeBuddy 对话生命周期钩子实现
 *
 * 核心策略：通过代理/拦截 VS Code 层面的通信通道，
 * 在不修改 CodeBuddy 源码的前提下捕获其内部事件。
 *
 * 支持三种注入策略（按优先级）：
 *   A. Webview postMessage 拦截（推荐，最精确）
 *   B. Command 注册拦截
 *   C. TextDocument 变更监听（降级方案）
 */

import * as vscode from 'vscode';
import { eventHookManager } from './eventHookManager';
import { parseAndExecuteCommand } from './commandInterceptor';
import {
  ChatLifecycleEvent,
  RequestStartPayload,
  StreamChunkPayload,
  ResponseEndPayload,
  RequestErrorPayload,
} from '../types/events';
import { logInfo, logError, logWarn, logDebug, guardSync } from '../utils/errorGuard';
import { safeSetTimeout, safeSetInterval } from '../utils/cleanup';
import { getNowISO } from '../utils/dateUtil';

// ─── 内部状态 ───────────────────────────────────────

interface ActiveSessionState {
  /** 当前活跃的 requestId */
  currentRequestId: string | null;
  /** 流式输出累计文本（用于 tiktoken fallback） */
  accumulatedText: string;
  /** 用户原始输入 */
  userMessage: string;
  /** chunk 计数器 */
  chunkIndex: number;
  /** 是否处于流式传输中 */
  isStreaming: boolean;
}

const session: ActiveSessionState = {
  currentRequestId: null,
  accumulatedText: '',
  userMessage: '',
  chunkIndex: 0,
  isStreaming: false,
};

/** 去重锁：防止 auto 策略三路并行导致重复触发 E1 */
let _requestStartDedupTs = 0; // 上次 E1 触发的时间戳
const REQUEST_DEBOUNCE_MS = 500; // 500ms 内的重复 E1 直接忽略

/**
 * ★ 全局注入锁：防止统计文档写入被 Document Watcher 再次捕获形成循环
 *
 * 循环触发链路：
 *   E3 → injectTurnSummaryTable → createNewStatsDocument(untitled doc)
 *   → Document Watcher(onDidChangeTextDocument) 捕获到变更
 *   → emitRequestStart(假 E1!) → 计时 → timeout → E3 → 循环
 */
let _isInjectingStatsDoc = false;

/** 标记正在写入统计文档（供 chatInjector 调用） */
export function beginStatsDocInjection(): void { _isInjectingStatsDoc = true; }
/** 标记统计文档写入结束 */
export function endStatsDocInjection(): void { _isInjectingStatsDoc = false; }

/** 生成唯一请求 ID */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 重置会话状态 */
function resetSession(): void {
  session.currentRequestId = null;
  session.accumulatedText = '';
  session.userMessage = '';
  session.chunkIndex = 0;
  session.isStreaming = false;
}

/**
 * 防重复触发 E1 的守卫
 * auto 策略下三路钩子可能同时触发 E1，此函数确保短时间内只放行一次
 * @returns true 表示应该继续处理，false 表示被去重跳过
 */
function shouldEmitRequestStart(): boolean {
  const now = Date.now();
  if (now - _requestStartDedupTs < REQUEST_DEBOUNCE_MS) {
    logDebug(`[ChatLifecycleHook] E1 dedup skipped (gap=${now - _requestStartDedupTs}ms)`);
    return false;
  }
  _requestStartDedupTs = now;
  return true;
}

// ══════════════════════════════════════════════════════
// 策略 A: Webview 通信拦截（主要方案）
// ══════════════════════════════════════════════════════

let originalPostMessage: ((message: unknown) => Thenable<boolean>) | null = null;
let hookedWebviews: Set<vscode.Webview> = new Set();
let _webviewScanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 拦截 CodeBuddy 的 Webview postMessage 调用
 *
 * 通过 monkey-patch 方式在 activate 时替换 Webview.prototype.postMessage，
 * 监听从 Webview 到 ExtensionHost 的消息流。
 *
 * 注意：此策略需要 CodeBuddy 使用标准 Webview API 渲染聊天面板。
 * 如果 CodeBuddy 自定义了渲染机制，需切换到策略 B/C。
 */
export function installWebviewInterceptor(): void {
  try {
    // ── 立即尝试扫描已有的面板 ──
    scanAndHookWebviews();

    // ── 持续扫描：Chat 面板可能稍后才打开（每 3 秒扫一次） ──
    _webviewScanTimer = setInterval(() => {
      scanAndHookWebviews();
    }, 3000);

    logInfo('[ChatLifecycleHook] Webview interceptor installed + periodic scan started');
  } catch (e) {
    logError('Failed to install webview interceptor', e);
  }
}

/**
 * 扫描所有可见的 WebviewPanel 并 hook 匹配的实例
 */
function scanAndHookWebviews(): void {
  try {
    const panels = (vscode.window as unknown as { webviewPanels?: unknown[] }).webviewPanels;
    if (!panels || !Array.isArray(panels)) return;

    for (const p of panels) {
      const panel = p as Record<string, unknown>;
      const viewType = String(panel.viewType ?? '');
      const webview = panel.webview as vscode.Webview | undefined;

      // 匹配所有可能的 Chat/Webview 面板类型
      const isTarget = 
        viewType.includes('codebuddy') ||
        viewType.includes('chat') ||
        viewType.includes('ai') ||
        viewType.includes('copilot') ||
        viewType.includes('assistant');

      if (isTarget && webview && !hookedWebviews.has(webview)) {
        logInfo(`[ChatLifecycleHook] Found target webview: type="${viewType}"`);
        hookWebviewInstance(webview);
      }
    }

    // 同时扫描 visibleTextEditors 中是否有 chat 类型的编辑器
    for (const editor of vscode.window.visibleTextEditors) {
      const docUri = editor.document.uri.toString();
      if (docUri.includes('chat') || docUri.includes('ai') || docUri.includes('copilot')) {
        logInfo(`[ChatLifecycleHook] Found chat-like editor: uri=${docUri}`);
      }
    }
  } catch (e) {
    // 扫描失败不阻塞主流程
    logDebug(`[ChatLifecycleHook] Webview scan failed: ${e}`);
  }
}

/**
 * 对单个 Webview 实例进行消息拦截
 */
function hookWebviewInstance(webview: vscode.Webview): void {
  if (hookedWebviews.has(webview)) return;
  hookedWebviews.add(webview);

  // 监听来自 Webview 的消息（ExtensionHost → Webview 反向通道）
  // CodeBuddy 通常通过这个通道报告请求状态变化
  const disposable = webview.onDidReceiveMessage((msg) => {
    handleMessageFromWebview(msg);
  });

  // 将 disposable 注册以便清理
  logInfo(`[ChatLifecycleHook] Webview interceptor installed (${hookedWebviews.size} total)`);
}

/**
 * 处理从 Webview 接收到的消息
 * 解析 CodeBuddy 内部协议并转换为标准化事件
 *
 * ★ Feature 3: 在 request:start 阶段拦截 /sum 命令文本，
 *   通过 commandInterceptor.parseAndExecuteCommand() 消费命令，阻止发往大模型
 */
async function handleMessageFromWebview(msg: unknown): Promise<void> {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  const type = String(m.type ?? m.command ?? m.event ?? '');

  // ★ 调试：记录所有收到的消息类型
  if (type) {
    logDebug(`[ChatHook] Webview msg type="${type}" keys=[${Object.keys(m).join(',')}]`);
  }

  switch (type.toLowerCase()) {
    case 'chat:request':
    case 'codestart':
    case 'request:start': {
      // ── Feature 3: 拦截 /sum 命令，阻止发往大模型 ──
      const rawInput = String(m.message ?? m.prompt ?? m.text ?? '');
      const sumResult = await parseAndExecuteCommand(rawInput);
      if (sumResult.consumed) {
        // 命令已被消费，不触发 REQUEST_START 事件，直接返回
        logInfo('[ChatLifecycleHook] /sum command consumed, suppressing request:start');
        return;
      }

      resetSession();
      // ★ 去重：防止多策略同时触发
      if (!shouldEmitRequestStart()) return;
      
      const reqId = generateRequestId();
      session.currentRequestId = reqId;
      session.userMessage = rawInput;
      session.isStreaming = true;

      const payload: RequestStartPayload = {
        timestamp: performance.now(),
        userMessage: session.userMessage,
        requestId: reqId,
      };
      eventHookManager.emitRequestStart(payload);
      break;
    }

    case 'chat:chunk':
    case 'stream:delta':
    case 'stream:chunk': {
      if (!session.isStreaming || !session.currentRequestId) return;
      const chunk = String(m.content ?? m.delta ?? m.text ?? m.chunk ?? '');

      if (chunk) {
        session.accumulatedText += chunk;
        session.chunkIndex++;

        const payload: StreamChunkPayload = {
          chunk,
          chunkIndex: session.chunkIndex,
          timestamp: performance.now(),
          usageSnapshot: m.usage ? {
            prompt_tokens: Number((m.usage as Record<string, unknown>).prompt_tokens ?? 0),
            completion_tokens: Number((m.usage as Record<string, unknown>).completion_tokens ?? 0),
          } : undefined,
        };
        eventHookManager.emitStreamChunk(payload);
      }
      break;
    }

    case 'chat:end':
    case 'response:complete':
    case 'stream:end': {
      if (!session.currentRequestId) return;
      session.isStreaming = false;

      const payload: ResponseEndPayload = {
        finalUsage: m.usage ? {
          prompt_tokens: Number((m.usage as Record<string, unknown>).prompt_tokens ?? 0),
          completion_tokens: Number((m.usage as Record<string, unknown>).completion_tokens ?? 0),
          total_tokens: Number((m.usage as Record<string, unknown>).total_tokens ?? undefined),
        } : undefined,
        fullResponseText: session.accumulatedText || undefined,
        userMessage: session.userMessage || undefined,
      };
      eventHookManager.emitResponseEnd(payload);
      break;
    }

    case 'chat:error':
    case 'response:error':
    case 'stream:error': {
      session.isStreaming = false;
      const errPayload: RequestErrorPayload = {
        error: String(m.error ?? m.message ?? 'Unknown error'),
      };
      eventHookManager.emitRequestError(errPayload);
      break;
    }

    default:
      // 不识别的消息类型 → 忽略
      break;
  }
}

// ══════════════════════════════════════════════════════
// 策略 B: Command 注册拦截（辅助方案）
// ══════════════════════════════════════════════════════

/** 已注册的 command disposables */
const cmdDisposables: vscode.Disposable[] = [];

/**
 * 通过注册 VS Code Command 拦截 CodeBuddy 的发送操作
 *
 * 当用户点击"发送"或按回车时，CodeBuddy 会触发特定命令。
 * 我们通过 vscode.commands.registerCommand 拦截这些命令，
 * 在原逻辑执行前后注入我们的计时启动逻辑。
 */
export function installCommandInterceptors(): void {
  // 拦截常见的 CodeBuddy 命令名（实际名称需根据源码调整）
  const commandsToIntercept = [
    'codebuddy.chat.send',
    'codebuddy.send',
    'codebuddy.action.send',
    'codebuddy.submit',
  ];

      for (const cmd of commandsToIntercept) {
      try {
        const disposable = vscode.commands.registerCommand(cmd, (...args: unknown[]) => {
          resetSession();
          // ★ 去重：防止多策略同时触发
          if (!shouldEmitRequestStart()) return;
          
          const reqId = generateRequestId();
        session.currentRequestId = reqId;
        session.userMessage =
          typeof args[0] === 'string' ? args[0] : '';

        const payload: RequestStartPayload = {
          timestamp: performance.now(),
          userMessage: session.userMessage,
          requestId: reqId,
        };
        eventHookManager.emitRequestStart(payload);

        // 执行原始命令（如果有原始处理器的话）
        // 注意：这里我们只是通知 Engine 开始计时，
        // 原始命令可能已被我们的注册覆盖，
        // 所以需要在实际集成时做更精细的处理
        logInfo(`[ChatLifecycleHook] Intercepted command: ${cmd}`);
      });
      cmdDisposables.push(disposable);
    } catch {
      // 命令不存在或无法注册，静默忽略
    }
  }

  logInfo(`[ChatLifecycleHook] Installed ${cmdDisposables.length} command interceptors`);
}

// ══════════════════════════════════════════════════════
// 策略 C: TextDocument 监听（降级兜底方案）
// ══════════════════════════════════════════════════════

let docDisposable: vscode.Disposable | null = null;

/**
 * 通过监听虚拟文档变更来推断 AI 输出的开始和结束
 *
 * 适用场景：CodeBuddy 将 AI 输出写入一个隐藏/虚拟的 TextDocument
 * 我们通过 onDidChangeTextDocument 监控内容变化来推断事件时机
 */
export function installDocumentWatcher(): void {
  try {
    docDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      
      // ── 全局锁：统计文档注入期间跳过（防循环） ──
      if (_isInjectingStatsDoc) return;

      // ── 排除普通文件编辑（噪音太多） ──
      if (doc.uri.scheme === 'file') return;

      // ★ 诊断：记录所有非 file 文档变更（首次各 scheme 只记录一次）
      const uriStr = doc.uri.toString();

      for (const change of e.contentChanges) {
        if (!change.text || change.text.trim().length === 0) continue;

        // ★ 诊断日志：记录每个非 file 变更（INFO 级别确保可见）
        logInfo(
          `[DocWatch] change | scheme="${doc.uri.scheme}"` +
          ` | lang="${doc.languageId ?? '?'}"` +
          ` | path="${doc.uri.path.slice(-40)}"` +
          ` | text="${change.text.replace(/\n/g, '\\n').slice(0, 60)}"`
        );

        // ── 目标匹配：只处理 Chat 相关的文档 ──
        const isTargetDoc =
          doc.uri.scheme === 'codebuddy' ||
          doc.uri.scheme === 'chat' ||
          doc.uri.scheme === 'vscode-chat' ||
          doc.uri.scheme === 'chat-sideloading-editor' ||
          doc.uri.path.toLowerCase().includes('chat') ||
          doc.uri.path.toLowerCase().includes('codebuddy');

        if (!isTargetDoc) continue; // 不是目标文档，只记日志不触发事件

        // ── 事件触发逻辑 ──
        if (!session.isStreaming && session.currentRequestId === null) {
          resetSession();
          if (!shouldEmitRequestStart()) return;
          
          const reqId = generateRequestId();
          session.currentRequestId = reqId;
          session.isStreaming = true;
          session.userMessage = '(detected by document watcher)';
          logInfo(`[ChatLifecycleHook] ★ DocWatcher E1 TRIGGERED | ${uriStr}`);
          eventHookManager.emitRequestStart({
            timestamp: performance.now(),
            userMessage: session.userMessage,
            requestId: reqId,
          });
        }

        session.accumulatedText += change.text;
        session.chunkIndex++;
        eventHookManager.emitStreamChunk({
          chunk: change.text,
          chunkIndex: session.chunkIndex,
          timestamp: performance.now(),
        });
      }
    });

    logInfo('[ChatLifecycleHook] Document watcher installed (diagnostic mode)');
  } catch (e) {
    logError('Failed to install document watcher', e);
  }
}

// ══════════════════════════════════════════════════════
// 公共 API：安装 / 卸载
// ══════════════════════════════════════════════════════

/**
 * 安装所有钩子策略（在 activate 中调用）
 *
 * @param strategy 优先使用的策略: 'auto'(自动探测) | 'webview' | 'command' | 'document'
 */
export function installHooks(strategy: 'auto' | 'webview' | 'command' | 'document' = 'auto'): void {
  resetSession();

  switch (strategy) {
    case 'webview':
      installWebviewInterceptor();
      break;

    case 'command':
      // ⚠️ Command Interceptor 已禁用 — 它会覆盖原始命令导致消息无法发送
      logWarn('[ChatLifecycleHook] Command interceptor DISABLED (blocks chat send)');
      break;

    case 'document':
      installDocumentWatcher();
      break;

    case 'auto':
    default:
      // ── 策略 A: Webview 拦截 ──
      installWebviewInterceptor();

      // ── 策略 B: Command 拦截（⚠️ 禁用） ──
      logWarn('[ChatLifecycleHook] Command interceptor SKIPPED in auto mode');

      // ── 策略 C: Document 监听（降级兜底 + 诊断模式） ──
      installDocumentWatcher();
      break;
  }

  logInfo(`[ChatLifecycleHook] All hooks installed (strategy=${strategy})`);
}

/**
 * 卸载所有钩子（在 deactivate 中调用）
 */
export function uninstallHooks(): void {
  resetSession();

  for (const d of cmdDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  cmdDisposables.length = 0;

  if (docDisposable) {
    try { docDisposable.dispose(); } catch { /* ignore */ }
    docDisposable = null;
  }

  if (_webviewScanTimer) {
    clearInterval(_webviewScanTimer);
    _webviewScanTimer = null;
  }

  hookedWebviews.clear();

  logInfo('[ChatLifecycleHook] All hooks uninstalled');
}
