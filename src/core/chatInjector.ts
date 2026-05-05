/**
 * 聊天面板内容注入器（VS Code 原生 UI 通道实现）
 *
 * 由于 CodeBuddy 使用 VS Code 内置侧边栏 Chat 面板，无法直接操作其 DOM，
 * 本模块通过以下 VS Code 原生 UI 组件实现数据展示：
 *
 *   Feature 1 — 实时计时：StatusBar 状态栏实时刷新 ⏱ x.xs
 *   Feature 2 — 统计表格：Untitled Markdown Document（编辑器区域展示）+ OutputChannel
 *   Feature 3 — /sum 汇总：OutputChannel + 可选通知弹窗
 *
 * 注入策略优先级：
 *   1. StatusBar（实时计时，低干扰）
 *   2. Untitled Markdown Document（统计表格，编辑器内可见，最接近 Chat 窗口体验）
 *   3. OutputChannel（详细日志备份，结构化输出）
 *   4. showInformationMessage（重要事件提醒，可选）
 */

import * as vscode from 'vscode';
import { logInfo, logError, logWarn, logDebug, getOutputChannelInstance } from '../utils/errorGuard';
import { beginStatsDocInjection, endStatsDocInjection } from '../hook/chatLifecycleHook';

// ─── 类型定义 ───────────────────────────────────────

/** 注入操作结果 */
export interface InjectResult {
  success: boolean;
  error?: string;
}

/** 状态栏项引用 */
let _statusBarItem: vscode.StatusBarItem | null = null;

/** 统计文档引用（Untitled Markdown Document，用于在编辑器区显示统计表格） */
let _statsDoc: vscode.TextDocument | null = null;

// ══════════════════════════════════════════════════════
// 初始化 / 销毁（由 vsextension 调用）
// ══════════════════════════════════════════════════════

/**
 * 初始化注入器（在 activate 时调用一次）
 * 创建 StatusBar 项用于 Feature 1 实时计时显示
 */
export function initInjector(): void {
  if (_statusBarItem) return; // 避免重复创建

  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100 // 优先级（越小越靠左）
  );
  _statusBarItem.name = 'CodeBuddy Timer';
  _statusBarItem.command = 'codebuddy.enhance.showOutput'; // 点击打开日志
  _statusBarItem.tooltip = 'CodeBuddy Enhance — 点击查看详情';

  logInfo('[Injector] Initialized (StatusBar ready)');
}

/**
 * 销毁注入器（在 deactivate 时调用）
 */
export function disposeInjector(): void {
  if (_statusBarItem) {
    _statusBarItem.dispose();
    _statusBarItem = null;
    logInfo('[Injector] Disposed');
  }
}

// ══════════════════════════════════════════════════════
// Feature 1: 实时计时 — StatusBar 显示
// ══════════════════════════════════════════════════════

/**
 * 定位当前 AI 输出行（StatusBar 方案下返回占位标识符）
 *
 * @returns 始终返回 '__statusbar__' 表示使用状态栏作为输出目标
 */
export function locateCurrentOutputLine(): string | null {
  return '__statusbar__';
}

/**
 * 在状态栏动态更新实时计时文案
 *
 * @param lineId     目标标识（忽略，统一使用 StatusBar）
 * @param displayText 要显示的文本 (如 "⏱ 3.2s")
 */
export function appendDynamicText(lineId: string, displayText: string): InjectResult {
  try {
    if (!_statusBarItem) {
      return { success: false, error: 'StatusBar not initialized' };
    }

    _statusBarItem.text = `$(clock) ${displayText}`;
    _statusBarItem.show();

    return { success: true };
  } catch (e) {
    logError('[Injector] appendDynamicText failed', e);
    return { success: false, error: String(e) };
  }
}

/**
 * 替换状态栏文案为最终固定值（对话结束时调用）
 *
 * @param lineId    目标标识（忽略）
 * @param finalText 最终要显示的文本
 */
export function replaceLineTailText(lineId: string, finalText: string): InjectResult {
  try {
    if (!_statusBarItem) {
      return { success: false, error: 'StatusBar not initialized' };
    }

    // 对话结束：显示完成标记 + 最终数据
    _statusBarItem.text = `$(check) ${finalText}`;

    // 5 秒后自动隐藏（避免一直占用状态栏）
    setTimeout(() => {
      if (_statusBarItem && !_statusBarItem.text.includes('$(clock)')) {
        _statusBarItem.hide();
      }
    }, 5000);

    return { success: true };
  } catch (e) {
    logError('[Injector] replaceLineTailText failed', e);
    return { success: false, error: String(e) };
  }
}

// ══════════════════════════════════════════════════════
// Feature 2 & 3: 统计表格 — OutputChannel 显示
// ══════════════════════════════════════════════════════

/**
 * 向输出通道写入 Markdown 内容（统计表格 / 日汇总等）
 *
 * 三通道输出：
 *   1. Untitled Markdown Document — 编辑器区域展示（用户可见的主要位置）
 *   2. OutputChannel — 输出面板备份（详细日志）
 *
 * 用于：
 *   - Feature 2: 单轮对话结束后的统计表格
 *   - Feature 3: /sum 日汇总命令的完整报告
 *
 * @param markdown Markdown 格式的字符串（表格、标题、说明文字等）
 */
export function appendMarkdownTable(markdown: string): InjectResult {
  try {
    if (!markdown?.trim()) {
      return { success: false, error: 'markdownTable is empty' };
    }

    // ── Channel 1: Untitled Markdown Document（编辑器区域） ──
    appendToStatsDocument(markdown);

    // ── Channel 2: OutputChannel（输出面板备份） ──
    const outputChannel = getOutputChannelInstance();
    
    const separator = '─'.repeat(60);
    outputChannel.appendLine('');
    outputChannel.appendLine(separator);
    outputChannel.append(markdown);
    outputChannel.appendLine(separator);
    outputChannel.appendLine('');

    try {
      outputChannel.show(true); // true = 保持焦点不抢走
    } catch {
      // show 可能失败，不影响数据写入
    }

    logDebug(`[Injector] Table written to StatsDoc + OutputChannel (${markdown.length} chars)`);

    return { success: true };
  } catch (e) {
    logError('[Injector] appendMarkdownTable failed', e);
    return { success: false, error: String(e) };
  }
}

/**
 * 将 Markdown 内容追加到统计文档（Untitled Document，显示在编辑器区域）
 *
 * 策略：
 *   - 首次调用：创建新的 Untitled Document 并打开
 *   - 后续调用：在已有文档末尾追加内容
 *   - 文档始终以 Markdown 语言模式打开，支持渲染
 */
function appendToStatsDocument(markdown: string): void {
  try {
    // ★ 加锁：防止 Document Watcher 捕获到我们的文档变更
    beginStatsDocInjection();
    
    const header = '# 📊 CodeBuddy 统计\n\n> 由 CodeBuddy Enhance 自动生成 | ' +
      new Date().toLocaleString('zh-CN', { hour12: false }) + '\n\n';

    if (_statsDoc) {
      // 已有文档 → 追加到末尾
      const editor = vscode.window.visibleTextEditors.find(
        e => e.document === _statsDoc
      );
      if (editor) {
        editor.edit(editBuilder => {
          const lastLine = _statsDoc!.lineCount - 1;
          const lastChar = _statsDoc!.lineAt(lastLine).text.length;
          editBuilder.insert(
            new vscode.Position(lastLine, lastChar),
            '\n\n---\n\n' + markdown
          );
        });
      } else {
        // 编辑器被关闭了 → 重建文档
        createNewStatsDocument(header, markdown);
      }
    } else {
      // 首次 → 创建新文档
      createNewStatsDocument(header, markdown);
    }

    logDebug('[Injector] Stats document updated');
  } catch (e) {
    logError('[Injector] appendToStatsDocument failed', e);
  } finally {
    // ★ 解锁（无论成功失败都必须释放）
    endStatsDocInjection();
  }
}

/**
 * 创建新的统计文档并在编辑器中打开
 */
function createNewStatsDocument(header: string, content: string): void {
  const fullContent = header + content;
  
  vscode.workspace.openTextDocument({
    content: fullContent,
    language: 'markdown'
  }).then(doc => {
    _statsDoc = doc;
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside).then(() => {
      logInfo('[Injector] Stats document opened in editor');
    }, () => {
      logWarn('[Injector] Failed to show stats document');
    });
  }, () => {
    logWarn('[Injector] Failed to create stats document');
  });
}

// ══════════════════════════════════════════════════════
// 辅助方法（兼容旧接口，保留但不推荐使用）
// ══════════════════════════════════════════════════════

/**
 * 清除状态栏显示（会话切换 / 新对话开始时调用）
 */
export function clearDisplay(): void {
  if (_statusBarItem) {
    _statusBarItem.hide();
    _statusBarItem.text = '';
  }
  // 注意：不清除 _statsDoc，让它保留作为历史记录
}

/** 获取当前统计文档引用（供外部命令使用） */
export function getStatsDocument(): vscode.TextDocument | null {
  return _statsDoc;
}

/** 关闭统计文档（供外部命令使用） */
export function closeStatsDocument(): void {
  if (!_statsDoc) return;
  
  // 查找并关闭显示该文档的编辑器标签页
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === _statsDoc) {
      // 使用命令关闭对应编辑器标签页
      vscode.commands.executeCommand('workbench.action.closeActiveEditor',
        editor
      );
      break;
    }
  }
  _statsDoc = null;
}
