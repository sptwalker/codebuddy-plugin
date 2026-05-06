/**
 * OfficialHookBridge — CodeBuddy 官方 Hooks 事件桥接
 *
 * CodeBuddy 官方 Hook 不提供 VS Code 扩展内直接订阅 API，但支持在
 * UserPromptSubmit / Stop / SessionEnd / StopFailure 等生命周期节点执行脚本。
 * 本桥接层监听官方 Hook 脚本写入的 JSONL 事件文件，并转换为本扩展内部 E1-E5 事件。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { eventHookManager } from './eventHookManager';
import { parseAndExecuteCommand } from './commandInterceptor';
import type { RequestStartPayload, ResponseEndPayload, RequestErrorPayload } from '../types/events';
import { logDebug, logError, logInfo, logWarn } from '../utils/errorGuard';

const EVENT_FILE_NAME = 'codebuddy-enhance-events.jsonl';
const EVENT_FILE_RELATIVE_PATH = `.codebuddy/${EVENT_FILE_NAME}`;
const MAX_TRANSCRIPT_READ_BYTES = 2 * 1024 * 1024;

type OfficialHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PreToolUse'
  | 'PostToolUse'
  | string;

interface OfficialHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: OfficialHookEventName;
  prompt?: string;
  stop_hook_active?: boolean;
  reason?: string;
  error?: string | { message?: string };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  __enhance_hook_diag?: {
    argv?: string[];
    env?: Record<string, string>;
    _discovery_result?: string;
  };
  /** Hook 脚本主动发现的 transcript 路径（Stop/SubagentStop 时填充） */
  _discovered_transcript_path?: string;
}

interface ActiveOfficialTurn {
  requestId: string;
  sessionId: string;
  userMessage: string;
}

let _watcher: vscode.FileSystemWatcher | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _extensionRoot: string | null = null;
let _installed = false;
let _activeTurn: ActiveOfficialTurn | null = null;
const _fileOffsets = new Map<string, number>();
const _processedStops = new Set<string>();
/**
 * 当 /sum 等 internal command 被 consumed 后，CodeBuddy 仍可能发出一个幽灵 Stop。
 * 此标志用于抑制该 Stop 触发完整的 E1→E3 统计流程。
 */
let _suppressNextStop = false;
/** 抑制计数器：consumed 命令后需要连续抑制的 Stop/SubagentStop 次数 */
let _suppressStopCount = 0;

function generateRequestId(input: OfficialHookInput): string {
  const session = input.session_id || 'official-hook';
  return `${session}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getEventFilePaths(): string[] {
  const roots = new Set<string>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.add(folder.uri.fsPath);
  }

  if (_extensionRoot) {
    roots.add(_extensionRoot);
  }

  return [...roots].map((root) => path.join(root, EVENT_FILE_RELATIVE_PATH));
}

async function initializeEventFileOffsets(): Promise<void> {
  for (const filePath of getEventFilePaths()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = await fs.promises.stat(filePath);
      _fileOffsets.set(filePath, stat.size);
      logInfo(`[OfficialHookBridge] initial offset set | file=${filePath} | size=${stat.size}`);
    } catch (e) {
      logWarn('[OfficialHookBridge] failed to initialize file offset', e);
    }
  }
}

function scheduleProcess(filePath: string): void {
  setTimeout(() => {
    processEventFile(filePath).catch((e) => logError('[OfficialHookBridge] process failed', e));
  }, 50);
}

async function processEventFile(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  const stat = await fs.promises.stat(filePath);
  let offset = _fileOffsets.get(filePath) ?? 0;
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return;

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    _fileOffsets.set(filePath, stat.size);

    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    logInfo(`[OfficialHookBridge] processing ${lines.length} new event line(s) from ${filePath}`);

    for (const line of lines) {
      await handleOfficialHookLine(line);
    }
  } finally {
    await handle.close();
  }
}

async function handleOfficialHookLine(line: string): Promise<void> {
  let input: OfficialHookInput;
  try {
    input = JSON.parse(line) as OfficialHookInput;
  } catch (e) {
    logWarn('[OfficialHookBridge] invalid JSONL hook event ignored', e);
    return;
  }

  const eventName = input.hook_event_name || '';
  logInfo(`[OfficialHookBridge] official hook received: ${eventName}`);
  logInfo(
    `[OfficialHookBridge] hook payload` +
    ` | event=${eventName || '(unknown)'}` +
    ` | keys=[${Object.keys(input).join(',')}]` +
    ` | session=${input.session_id || '(none)'}` +
    ` | transcript=${input.transcript_path || '(none)'}` +
    ` | cwd=${input.cwd || '(none)'}` +
    ` | promptLen=${input.prompt ? input.prompt.length : 0}`
  );
  if (input.__enhance_hook_diag) {
    logInfo(
      `[OfficialHookBridge] hook env diag` +
      ` | argv=[${(input.__enhance_hook_diag.argv || []).join(',')}]` +
      ` | envKeys=[${Object.keys(input.__enhance_hook_diag.env || {}).join(',')}]` +
      ` | env=${JSON.stringify(input.__enhance_hook_diag.env || {})}`
    );
  }

  switch (eventName) {
    case 'UserPromptSubmit':
      await handleUserPromptSubmit(input);
      break;
    case 'Stop':
    case 'SubagentStop':
      await handleStop(input);
      break;
    case 'SessionEnd':
      handleSessionEnd(input);
      break;
    case 'StopFailure':
      handleStopFailure(input);
      break;
    case 'SessionStart':
      logDebug('[OfficialHookBridge] SessionStart observed');
      break;
    default:
      break;
  }
}

async function handleUserPromptSubmit(input: OfficialHookInput): Promise<void> {
  const prompt = input.prompt || '';
  const sumResult = await parseAndExecuteCommand(prompt);
  if (sumResult.consumed) {
    logInfo('[OfficialHookBridge] /sum command consumed, suppressing request start + next Stops');
    _suppressNextStop = true;
    _suppressStopCount = 2; // 抑制接下来 2 个 Stop/SubagentStop
    return;
  }

  if (_activeTurn) {
    eventHookManager.emitSessionChange();
  }

  const requestId = generateRequestId(input);
  _activeTurn = {
    requestId,
    sessionId: input.session_id || 'unknown-session',
    userMessage: prompt,
  };

  const payload: RequestStartPayload = {
    timestamp: performance.now(),
    userMessage: prompt,
    requestId,
  };
  eventHookManager.emitRequestStart(payload);
}

function buildStopKey(input: OfficialHookInput, sessionId: string): string {
  const eventName = input.hook_event_name || 'Stop';
  const transcript = input.transcript_path || '';
  const activeFlag = input.stop_hook_active ? 'active' : 'normal';

  if (_activeTurn) {
    return `${eventName}:${sessionId}:${_activeTurn.requestId}:${transcript}:${activeFlag}`;
  }

  const fallback = transcript || input.reason || input.cwd || 'no-transcript';
  return `${eventName}:${sessionId}:${fallback}:${activeFlag}:${Date.now()}`;
}

function rememberProcessedStop(stopKey: string): void {
  _processedStops.add(stopKey);
  if (_processedStops.size > 200) {
    const oldest = _processedStops.values().next().value;
    if (oldest) _processedStops.delete(oldest);
  }
}

async function handleStop(input: OfficialHookInput): Promise<void> {
  // ★ 抑制 /sum 等内部命令消费后的幽灵 Stop（可能有多个：Stop + SubagentStop）
  if (_suppressStopCount > 0) {
    _suppressStopCount--;
    const eventName = input.hook_event_name || 'Stop';
    logInfo(`[OfficialHookBridge] ${eventName} suppressed (post-command, remaining=${_suppressStopCount})`);
    return;
  }

  const sessionId = input.session_id || _activeTurn?.sessionId || 'unknown-session';
  const stopKey = buildStopKey(input, sessionId);
  if (_processedStops.has(stopKey)) {
    logDebug(`[OfficialHookBridge] duplicate stop ignored | key=${stopKey}`);
    return;
  }
  rememberProcessedStop(stopKey);

  if (!_activeTurn) {
    const requestId = generateRequestId(input);
    _activeTurn = {
      requestId,
      sessionId,
      userMessage: '(official hook: prompt unavailable)',
    };
    eventHookManager.emitRequestStart({
      timestamp: performance.now(),
      userMessage: _activeTurn.userMessage,
      requestId,
    });
  }

  // ─── Transcript 路径解析优先级 ─────────────────────────────
  // 1. Hook 脚本主动发现的路径（最高优先级）
  // 2. 官方 Hook 原始提供的 transcript_path
  const transcriptPath =
    input._discovered_transcript_path ||
    input.transcript_path;

  const fullResponseText = await extractLatestAssistantText(transcriptPath);

  if (!transcriptPath) {
    logWarn('[OfficialHookBridge] Stop event has no transcript_path (neither original nor discovered); completion tokens/response length cannot be resolved');
  } else if (!fullResponseText) {
    logWarn(`[OfficialHookBridge] transcript found but no assistant text extracted | path=${transcriptPath}`);
  } else {
    logInfo(`[OfficialHookBridge] ✅ assistant text extracted from transcript | path=${transcriptPath} | length=${fullResponseText.length}`);
  }
  const payload: ResponseEndPayload = {
    fullResponseText: fullResponseText || undefined,
    userMessage: _activeTurn.userMessage,
  };
  eventHookManager.emitResponseEnd(payload);
  _activeTurn = null;
}

function handleSessionEnd(_input: OfficialHookInput): void {
  if (_activeTurn) {
    eventHookManager.emitSessionChange();
    _activeTurn = null;
  }
}

function handleStopFailure(input: OfficialHookInput): void {
  const error = typeof input.error === 'string'
    ? input.error
    : input.error?.message || input.reason || 'CodeBuddy official StopFailure';

  const payload: RequestErrorPayload = { error };
  eventHookManager.emitRequestError(payload);
  _activeTurn = null;
}

async function extractLatestAssistantText(transcriptPath?: string): Promise<string> {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';

  try {
    const stat = await fs.promises.stat(transcriptPath);
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_READ_BYTES);
    const handle = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const text = extractAssistantTextFromLine(lines[i]);
        if (text) return text;
      }
    } finally {
      await handle.close();
    }
  } catch (e) {
    logWarn('[OfficialHookBridge] transcript parse failed', e);
  }

  return '';
}

function extractAssistantTextFromLine(line: string): string {
  try {
    const item = JSON.parse(line) as Record<string, unknown>;
    const directRole = String(item.role ?? '');
    if (directRole === 'assistant') return normalizeContent(item.content);

    const message = item.message as Record<string, unknown> | undefined;
    if (message && String(message.role ?? item.type ?? '') === 'assistant') {
      return normalizeContent(message.content);
    }

    if (String(item.type ?? '') === 'assistant') {
      return normalizeContent(item.content ?? message?.content);
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string') return p.text;
      if (typeof p.content === 'string') return p.content;
    }
    return '';
  }).join('').trim();
}

export function installOfficialHookBridge(context: vscode.ExtensionContext): void {
  if (_installed) return;
  _installed = true;
  _extensionRoot = context.extensionUri.fsPath;

  const watcherRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || _extensionRoot || process.cwd();
  const pattern = new vscode.RelativePattern(
    watcherRoot,
    `**/.codebuddy/${EVENT_FILE_NAME}`
  );
  _watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  _watcher.onDidCreate((uri) => scheduleProcess(uri.fsPath));
  _watcher.onDidChange((uri) => scheduleProcess(uri.fsPath));
  _watcher.onDidDelete((uri) => _fileOffsets.delete(uri.fsPath));
  context.subscriptions.push(_watcher);

  const pollEventFiles = () => {
    for (const filePath of getEventFilePaths()) {
      scheduleProcess(filePath);
    }
  };

  initializeEventFileOffsets()
    .catch((e) => logWarn('[OfficialHookBridge] initial offset setup failed', e))
    .finally(() => {
      pollEventFiles();
      _pollTimer = setInterval(pollEventFiles, 1000);
    });
  context.subscriptions.push({
    dispose: () => {
      if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
      }
    },
  });

  logInfo(
    `[OfficialHookBridge] installed, watching ${EVENT_FILE_RELATIVE_PATH} (watcher + polling)` +
    ` | files=${getEventFilePaths().join('; ') || '(no workspace folder)'}`
  );
}

export function uninstallOfficialHookBridge(): void {
  if (_watcher) {
    _watcher.dispose();
    _watcher = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _installed = false;
  _extensionRoot = null;
  _fileOffsets.clear();
  _processedStops.clear();
  logInfo('[OfficialHookBridge] uninstalled');
}
