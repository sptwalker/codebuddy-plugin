/**
 * 聊天面板内容注入器
 * 封装定位对话行、行尾文案追加/替换、追加 Markdown 表格等通用方法
 *
 * 核心策略：
 *   - 通过 VS Code Webview API 向聊天面板注入内容
 *   - 使用 postMessage / 修改 DOM 的方式实现非侵入式追加
 *   - 所有注入操作均通过容错包装，失败不影响主流程
 */

// import * as vscode from 'vscode'; // vscode 未直接使用，通过 guardSync 间接容错
import { logError, guardSync } from '../utils/errorGuard';

// ─── 类型定义 ───────────────────────────────────────

/** 注入目标面板的引用信息 */
export interface ChatPanelRef {
  /** Webview panel 实例（如果可获取） */
  webviewPanel?: unknown;
  /** 面板类型标识 */
  panelType: 'chat' | 'inline';
}

/** 注入操作结果 */
export interface InjectResult {
  success: boolean;
  error?: string;
}

// ─── 核心注入方法 ────────────────────────────────────

/**
 * [方法 1] 定位当前 AI 输出的最后一行
 *
 * 通过查询聊天面板 DOM 或维护内部状态来获取当前活跃的 AI 输出行。
 * 返回一个可用于后续追加/替换操作的行标识符。
 *
 * @returns 行标识符字符串，或 null 表示无法定位
 */
export function locateCurrentOutputLine(): string | null {
  try {
    // 策略：尝试从全局上下文获取当前活跃的输出区域
    // 实际实现将依赖 hook 层提供的面板引用
    // 此处返回占位符，具体定位逻辑在集成时由 eventHookManager 提供
    return '__current_line__';
  } catch (e) {
    logError('Failed to locate current output line', e);
    return null;
  }
}

/**
 * [方法 2] 在指定行尾动态追加实时计时文案
 *
 * 每次调用会先清除上一次的追加内容再写入新值，
 * 实现"刷新"效果而非重复叠加。
 *
 * @param lineId     目标行标识符
 * @param displayText 要追加的文本 (如 " ⏱ 3.2s")
 */
export function appendDynamicText(lineId: string, displayText: string): InjectResult {
  return guardSync<InjectResult>(
    () => {
      if (!lineId) {
        return { success: false, error: 'lineId is empty' };
      }

      // 通过 VS Code Command / Webview postMessage 执行注入
      const script = buildAppendScript(lineId, displayText);
      executeInjectScript(script);

      return { success: true };
    },
    { success: false, error: 'appendDynamicText failed' },
    'chatInjector.appendDynamicText'
  );
}

/**
 * [方法 3] 替换行尾文案为最终固定值
 *
 * 对话结束后调用，将动态计时替换为最终耗时 + Token 数量。
 *
 * @param lineId       目标行标识符
 * @param finalText    最终要显示的文本
 */
export function replaceLineTailText(lineId: string, finalText: string): InjectResult {
  return guardSync<InjectResult>(
    () => {
      if (!lineId) {
        return { success: false, error: 'lineId is empty' };
      }

      const script = buildReplaceScript(lineId, finalText);
      executeInjectScript(script);

      return { success: true };
    },
    { success: false, error: 'replaceLineTailText failed' },
    'chatInjector.replaceLineTailText'
  );
}

/**
 * [方法 4] 在聊天窗口末尾追加 Markdown 表格
 *
 * 用于 Feature 2 (单轮结束统计表) 和 Feature 3 (/sum 日汇总表)
 *
 * @param markdownTable Markdown 格式的表格字符串
 */
export function appendMarkdownTable(markdownTable: string): InjectResult {
  return guardSync<InjectResult>(
    () => {
      if (!markdownTable?.trim()) {
        return { success: false, error: 'markdownTable is empty' };
      }

      // 通过 CodeBuddy 的消息接口或 webview postMessage 追加
      const result = executeTableInjection(markdownTable);
      return { success: true };
    },
    { success: false, error: 'appendMarkdownTable failed' },
    'chatInjector.appendMarkdownTable'
  );
}

// ─── 内部脚本构建 ────────────────────────────────────

/**
 * 构建用于向 DOM 行尾追加/更新文本的 JS 脚本片段
 *
 * 在目标行的 .enhance-timer 元素上写入新文本；
 * 若元素不存在则创建并插入行尾。
 */
function buildAppendScript(lineId: string, text: string): string {
  return `
    (function() {
      var el = document.querySelector('[data-line-id="${lineId}"] .cb-enhance-timer');
      if (!el) {
        var parent = document.querySelector('[data-line-id="${lineId}"]');
        if (!parent) return;
        el = document.createElement('span');
        el.className = 'cb-enhance-timer cb-enhance-inline';
        parent.appendChild(el);
      }
      el.textContent = '${escapeJs(text)}';
      el.setAttribute('data-enhance', 'timer');
    })();
  `;
}

/**
 * 构建替换行尾文案为最终值的脚本
 * 与 append 类似，但添加 .final 标记样式类
 */
function buildReplaceScript(lineId: string, text: string): string {
  return `
    (function() {
      var el = document.querySelector('[data-line-id="${lineId}"] .cb-enhance-timer');
      if (!el) {
        var parent = document.querySelector('[data-line-id="${lineId}"]');
        if (!parent) return;
        el = document.createElement('span');
        el.className = 'cb-enhance-timer cb-enhance-final';
        parent.appendChild(el);
      }
      el.className = 'cb-enhance-timer cb-enhance-final';
      el.textContent = '${escapeJs(text)}';
    })();
  `;
}

/**
 * JS 字符串转义，防止 XSS 和脚本断裂
 */
function escapeJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ─── 注入执行层（抽象） ──────────────────────────────

/**
 * 执行注入脚本的实际方法
 *
 * 根据运行环境选择不同的注入策略：
 *   - 有 Webview 引用 → 通过 webview.postMessage 发送指令
 *   - 无 Webview → 通过 vscode.commands.executeCommand 触发
 *   - 均不可用 → 记录日志并降级处理
 */
function executeInjectScript(script: string): void {
  try {
    // 方案 A：通过命令触发 CodeBuddy 内部注入能力
    // 实际集成时此处将调用 VS Code API
    console.debug('[ChatInjector] executeInjectScript:', script.slice(0, 80));
    // TODO: 接入实际的 webview / command 注入通道
  } catch (e) {
    logError('executeInjectScript failed', e);
  }
}

/**
 * 执行 Markdown 表格注入
 */
function executeTableInjection(markdown: string): boolean {
  try {
    console.debug('[ChatInjector] executeTableInjection:', markdown.slice(0, 100));
    // TODO: 接入实际的表格注入通道（通过 CodeBuddy 消息系统）
    return true;
  } catch (e) {
    logError('executeTableInjection failed', e);
    return false;
  }
}
