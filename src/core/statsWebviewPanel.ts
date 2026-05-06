/**
 * StatsWebviewPanel — CodeBuddy Enhance 统计数据展示面板
 *
 * 通过 VS Code Webview Panel 提供独立的统计信息展示窗口：
 *   - Feature 1: 实时计时器（大字体，醒目）
 *   - Feature 2: 单轮对话统计表格
 *   - Feature 3: /sum 日汇总报告
 *
 * 使用方式：
 *   - 命令面板: "CodeBuddy Enhance: Show Stats Panel"
 *   - 自动: 对话开始时自动打开（可选配置）
 */

import * as vscode from 'vscode';
import { logInfo, logError, logDebug } from '../utils/errorGuard';

// ─── 面板状态 ─────────────────────────────────────

let _panel: vscode.WebviewPanel | null = null;
/** 当前显示的内容（用于增量更新，避免全量重渲染） */
let _currentHtml = '';

// ══════════════════════════════════════════════════════
// 公共 API — 生命周期
// ══════════════════════════════════════════════════════

/**
 * 初始化/获取统计面板（幂等）
 * 同一时间只存在一个实例；必须先调用此方法再调用其他 update 方法
 *
 * ★ 面板重建时自动从 globalState 恢复今日历史记录
 */
export async function getOrCreateStatsPanel(
  /** 可选：ExtensionContext 用于恢复历史记录（首次创建时传入） */
  context?: vscode.ExtensionContext,
): Promise<vscode.WebviewPanel> {
  if (_panel) {
    try { _panel.reveal(vscode.ViewColumn.Beside); } catch { /* disposed */ }
    return _panel;
  }

  _panel = vscode.window.createWebviewPanel(
    'codebuddyEnhanceStats',
    '📊 CodeBuddy 统计',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  _panel.webview.html = getBaseHtml();
  _currentHtml = '';

  // ★ 面板重建时，从持久化存储恢复今日历史记录
  if (context) {
    await restoreHistoryFromStorage(context);
  }

  _panel.onDidDispose(() => {
    _panel = null;
    logDebug('[StatsPanel] Disposed');
  });

  logInfo('[StatsPanel] Created (with history restore)');
  return _panel;
}

/**
 * 从 globalState 读取今日所有轮次并逐条追加到面板历史区
 */
async function restoreHistoryFromStorage(context: vscode.ExtensionContext): Promise<void> {
  try {
    const { readTodayStats } = await import('../storage/storageManager');
    const daily = await readTodayStats(context);
    if (!daily.turns || daily.turns.length === 0) return;

    const panel = getPanelRef();
    if (!panel) return;

    logInfo(`[StatsPanel] Restoring ${daily.turns.length} history entries from storage`);

    for (const turn of daily.turns) {
      const timeStr = turn.startTime
        ? new Date(turn.startTime).toLocaleTimeString('zh-CN', { hour12: false })
        : '--:--:--';
      panel.webview.postMessage({
        type: 'appendHistory',
        html: `<div class="history-item">
          <span class="hi-time">${escapeHtmlAttr(timeStr)}</span>
          <span class="hi-duration">${turn.durationReadable}</span>
          <span class="hi-tokens">${turn.tokenCount.totalTokens} tok</span>
          <span class="hi-msg">${escapeHtmlAttr(turn.userMessagePreview || '(空)')}</span>
          <span class="hi-status ${turn.finishStatus === 'normal' ? 'status-normal' :
            turn.finishStatus === 'interrupted' ? 'status-interrupted' : 'status-error'}">${
              turn.finishStatus === 'normal' ? '✅' : turn.finishStatus === 'interrupted' ? '⚠️' : '❌'
            }</span>
        </div>`
      });
    }
  } catch (e) {
    logError('[StatsPanel] History restore failed', e);
  }
}

/**
 * 关闭统计面板
 */
export function closeStatsPanel(): void {
  if (_panel) {
    _panel.dispose();
    _panel = null;
  }
}

/**
 * 检查面板当前是否可用（不触发创建）
 */
export function isStatsPanelVisible(): boolean {
  if (!_panel) return false;
  try { return _panel.visible; } catch { return false; }
}

/** 获取内部面板引用（供 Engine 直接使用，避免重复创建检查） */
export function getPanelRef(): vscode.WebviewPanel | null { return _panel; }

// ══════════════════════════════════════════════════════
// 内容更新方法（供 Engine 调用）
// ══════════════════════════════════════════════════════

/**
 * 更新实时计时显示
 *
 * @param elapsedMs 已耗时（毫秒）
 * @param isFinal   是否为最终值（对话结束时 true）
 */
export function updateTimerDisplay(elapsedMs: number, isFinal: boolean = false): void {
  const panel = getPanelRef();
  if (!panel) return; // 面板未初始化，静默跳过

  const seconds = (elapsedMs / 1000).toFixed(1);
  const icon = isFinal ? '✅' : '⏱';
  const className = isFinal ? 'timer-final' : 'timer-live';

  panel.webview.postMessage({
    type: 'updateTimer',
    html: `<span class="${className}">${icon} ${seconds}s</span>`
  });
}

/**
 * 设置最终结果（Token、速率等完整统计）
 */
export function setFinalResult(finalDisplay: string): void {
  const panel = getPanelRef();
  if (!panel) return;
  panel.webview.postMessage({ type: 'setFinal', text: finalDisplay });
}

/**
 * 追加 Markdown 表格内容（Feature 2 / Feature 3）
 */
export function appendMarkdownContent(markdown: string): void {
  const panel = getPanelRef();
  if (!panel) {
    logInfo('[StatsPanel] appendMarkdownContent: no panel available, skipping');
    return;
  }

  const html = markdownToHtml(markdown);
  logInfo(`[StatsPanel] appendMarkdownContent: sending ${html.length} chars of HTML`);
  panel.webview.postMessage({
    type: 'appendContent',
    html: `<div class="stats-block">${html}</div>`
  });
}

/**
 * 清除所有内容（新对话开始时调用）
 * 注意：不清空历史记录区，历史记录跨轮次累积
 */
export function clearContent(): void {
  const panel = getPanelRef();
  if (!panel) return;
  panel.webview.postMessage({ type: 'clear' });
}

/**
 * 追加一条紧凑的历史记录到历史滚动区
 * 每轮对话结束后调用，历史记录跨会话累积
 */
export function appendHistoryEntry(entry: {
  time: string;       // HH:mm:ss
  duration: string;   // "12.3s"
  tokens: string;     // "147"
  message: string;    // 用户消息预览
  status: 'ok' | 'warn' | 'error';
}): void {
  const panel = getPanelRef();
  if (!panel) return;

  const statusIcon = entry.status === 'ok' ? '✅' : entry.status === 'warn' ? '⚠️' : '❌';
  const statusClass = entry.status === 'ok' ? 'status-normal' :
    entry.status === 'warn' ? 'status-interrupted' : 'status-error';

  panel.webview.postMessage({
    type: 'appendHistory',
    html: `<div class="history-item">
      <span class="hi-time">${escapeHtmlAttr(entry.time)}</span>
      <span class="hi-duration">${entry.duration}</span>
      <span class="hi-tokens">${entry.tokens} tok</span>
      <span class="hi-msg">${escapeHtmlAttr(entry.message)}</span>
      <span class="hi-status ${statusClass}">${statusIcon}</span>
    </div>`
  });
}

/** HTML 属性转义（用于嵌入 HTML 属性值） */
function escapeHtmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ══════════════════════════════════════════════════════
// HTML 构建
// ══════════════════════════════════════════════════════

/** 基础 HTML 页面骨架（含 CSS + JS 消息监听） */
function getBaseHtml(): string {
  return /*html*/ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeBuddy Enhance</title>
  <style>
    :root {
      --bg-primary: #1e1e1e;
      --bg-secondary: #252526;
      --bg-highlight: #2d2d30;
      --text-primary: #cccccc;
      --text-secondary: #858585;
      --accent-blue: #0078d4;
      --accent-green: #4ec9b0;
      --accent-yellow: #dcdcaa;
      --accent-red: #f14c4c;
      --border-color: #3c3c3c;
      --timer-font: 48px;
    }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 16px;
      line-height: 1.6;
      font-size: 14px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 16px;
    }
    
    .header h1 {
      font-size: 16px;
      font-weight: 600;
      color: var(--accent-green);
    }

    .header .version {
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-highlight);
      padding: 2px 6px;
      border-radius: 3px;
    }

    /* ── 计时器显示区 ── */
    .timer-section {
      text-align: center;
      padding: 24px 16px;
      margin-bottom: 16px;
      background: var(--bg-secondary);
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    .timer-live {
      font-size: var(--timer-font);
      font-weight: 700;
      color: var(--accent-yellow);
      font-variant-numeric: tabular-nums;
      letter-spacing: -1px;
      animation: pulse 1s ease-in-out infinite;
    }

    .timer-final {
      font-size: var(--timer-font);
      font-weight: 700;
      color: var(--accent-green);
      font-variant-numeric: tabular-nums;
      animation: fadeIn 0.3s ease-out;
    }

    .final-result {
      margin-top: 12px;
      padding: 12px;
      background: var(--bg-highlight);
      border-radius: 4px;
      font-size: 13px;
      word-break: break-all;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── 统计表格区 ── */
    .content-area {
      overflow-y: auto;
      max-height: calc(100vh - 200px);
    }

    .stats-block {
      margin-bottom: 16px;
      padding: 12px;
      background: var(--bg-secondary);
      border-radius: 6px;
      border-left: 3px solid var(--accent-blue);
      animation: slideIn 0.25s ease-out;
    }

    .stats-block h2 {
      font-size: 15px;
      color: var(--accent-blue);
      margin-bottom: 10px;
    }

    .stats-block h3 {
      font-size: 13px;
      color: var(--accent-yellow);
      margin: 10px 0 6px;
    }

    .stats-block table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      table-layout: fixed;  /* 固定列宽，防止内容撑开 */
    }

    .stats-block th {
      text-align: left;
      padding: 6px 10px;
      background: var(--bg-highlight);
      color: var(--text-secondary);
      font-weight: 500;
      border-bottom: 1px solid var(--border-color);
      width: 60%;  /* 指标列占 60% */
    }

    .stats-block th:last-child,
    .stats-block td:last-child {
      width: 40%;  /* 数值列占 40% */
      text-align: right;
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace;
      font-variant-numeric: tabular-nums;
    }

    .stats-block td {
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      vertical-align: middle;
    }

    .stats-block tr:hover td {
      background: rgba(255,255,255,0.03);
    }

    .status-tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-normal { background: #1a3d1a; color: #4ec9b0; }
    .status-interrupted { background: #3d3d1a; color: #dcdcaa; }
    .status-error { background: #3d1a1a; color: #f14c4c; }

    .empty-msg {
      padding: 20px;
      text-align: center;
      color: var(--text-secondary);
      font-style: italic;
    }

    .quote-box {
      padding: 10px 14px;
      background: var(--bg-highlight);
      border-left: 3px solid var(--accent-green);
      margin: 8px 0;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .timestamp {
      text-align: right;
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 8px;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-8px); }
      to { opacity: 1; transform: translateX(0); }
    }

    /* 滚动条美化 */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }

    /* ── 历史记录滚动区 ── */
    .history-section {
      margin-top: 20px;
      border-top: 1px solid var(--border-color);
      padding-top: 12px;
    }

    .history-section h2 {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .history-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .history-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--bg-secondary);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 12px;
      border-left: 3px solid var(--border-color);
      transition: border-color 0.15s;
    }

    .history-item:hover {
      border-left-color: var(--accent-blue);
    }

    .history-item .hi-time {
      color: var(--text-secondary);
      font-family: 'Cascadia Code', Consolas, monospace;
      white-space: nowrap;
      min-width: 60px;
    }

    .history-item .hi-duration {
      color: var(--accent-yellow);
      font-family: 'Cascadia Code', Consolas, monospace;
      font-weight: 600;
      white-space: nowrap;
      min-width: 45px;
    }

    .history-item .hi-tokens {
      color: var(--accent-green);
      font-family: 'Cascadia Code', Consolas, monospace;
      white-space: nowrap;
      min-width: 50px;
    }

    .history-item .hi-msg {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary);
    }

    .history-item .hi-status {
      font-size: 11px;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 CodeBuddy Enhance</h1>
    <span class="version">v0.2.0</span>
  </div>

  <div id="timer" class="timer-section">
    <div style="color: var(--text-secondary); font-size: 14px;">等待对话...</div>
  </div>

  <div id="content" class="content-area"></div>

  <div class="history-section">
    <h2>📜 对话历史</h2>
    <div id="history" class="history-list"></div>
  </div>

  <script>
    // 监听来自 ExtensionHost 的消息
    window.addEventListener('message', (event) => {
      const msg = event.data;
      
      switch (msg.type) {
        case 'updateTimer':
          document.getElementById('timer').innerHTML = msg.html;
          break;

        case 'setFinal':
          document.getElementById('timer').innerHTML =
            '<div class="timer-final">' +
            '<div style="font-size:32px;color:#4ec9b0;">✅</div>' +
            '</div>' +
            '<div class="final-result">' + escapeHtml(msg.text) + '</div>';
          break;

        case 'appendContent':
          const container = document.getElementById('content');
          // 移除空状态提示
          const emptyEl = container.querySelector('.empty-msg');
          if (emptyEl) emptyEl.remove();
          container.insertAdjacentHTML('beforeend', msg.html);
          // 自动滚动到底部
          container.scrollTop = container.scrollHeight;
          break;

        case 'clear':
          document.getElementById('timer').innerHTML =
            '<div style="color: var(--text-secondary); font-size: 14px;">等待对话...</div>';
          document.getElementById('content').innerHTML = '';
          // 注意：不清空历史记录区，历史记录跨轮次累积
          break;

        case 'appendHistory': {
          const historyContainer = document.getElementById('history');
          const emptyHint = historyContainer.querySelector('.empty-hint');
          if (emptyHint) emptyHint.remove();
          historyContainer.insertAdjacentHTML('beforeend', msg.html);
          // 自动滚动到最新条目
          historyContainer.scrollTop = historyContainer.scrollHeight;
          break;
        }
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════
// 简易 Markdown → HTML 转换
// ══════════════════════════════════════════════════════

function markdownToHtml(md: string): string {
  let html = md;

  // 转义 HTML 特殊字符（先转义再处理 Markdown）
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // 引用块 (> ...)
  html = html.replace(/^> (.+)$/gm, '<div class="quote-box">$1</div>');

  // 加粗
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 表格处理
  html = convertTable(html);

  // 分隔线
  html = html.replace(/^─+$/gm, '<hr style="border:none;border-top:1px solid #3c3c3c;margin:8px 0;">');
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #3c3c3c;margin:8px 0;">');

  // 状态标签
  html = html.replace(/✅ 正常完成/g,
    '<span class="status-tag status-normal">✅ 正常完成</span>');
  html = html.replace(/⚠️ 已中断/g,
    '<span class="status-tag status-interrupted">⚠️ 已中断</span>');
  html = html.replace(/❌ 请求失败/g,
    '<span class="status-tag status-error">❌ 请求失败</span>');

  // 段落包裹
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // 清理空段落和嵌套问题（多次替换逐步修正）
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[2-6]>)/g, '$1');
  html = html.replace(/<\/h[2-6]><\/p>/g, (match: string) => match.replace('</p>', ''));
  html = html.replace(/<p>(<div[^>]*>)/g, '$1');
  html = html.replace(/<\/div><\/p>/g, '</div>');
  html = html.replace(/<p>(<table)/g, '$1');
  html = html.replace(/<\/table><\/p>/g, '</table>');

  return html;
}

/** 将 Markdown 表格转为 HTML table */
function convertTable(html: string): string {
  // 匹配 | ... | 格式的表格
  const lines = html.split('\n');
  const result: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (line.trim().startsWith('|') && line.includes('|')) {
      // 跳过分隔行 (| --- | --- |)
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;

      if (!inTable) {
        inTable = true;
        result.push('<table><tbody>');
      }

      const cells = line.split('|').filter(c => c.trim() !== '');
      const isFirst = !result[result.length - 1].includes('<tr>');
      const tag = isFirst ? 'th' : 'td';

      result.push('<tr>' + cells.map(c =>
        `<${tag}>${c.trim()}</${tag}>`
      ).join('') + '</tr>');
    } else {
      if (inTable) {
        result.push('</tbody></table>');
        inTable = false;
      }
      result.push(line);
    }
  }

  if (inTable) {
    result.push('</tbody></table>');
  }

  return result.join('\n');
}
