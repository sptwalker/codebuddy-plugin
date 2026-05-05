/**
 * CommandInterceptor — /sum 命令拦截器
 *
 * 职责：
 *   1. 注册 VS Code 自定义命令 codebuddy.enhance.sum
 *   2. 提供聊天输入框内 /sum 指令的识别与解析
 *   3. 拦截该输入，阻止传递给 CodeBuddy 核心（不发往大模型）
 *   4. 触发日汇总统计表的生成和输出到聊天窗口
 *
 * 实现方式：
 *   - vscode.commands.registerCommand 注册命令到插件激活生命周期
 *   - CompletionItemProvider 提供斜杠命令自动补全提示
 *   - 导出 isSumCommand() / executeSumCommand() 供钩子层调用拦截
 */

import * as vscode from 'vscode';
import { logInfo, logError } from '../utils/errorGuard';

// ─── 常量定义 ───────────────────────────────────────

/** 支持的所有增强命令列表 */
export const ENHANCE_COMMANDS = [
  {
    command: '/sum',
    description: '显示当日对话统计汇总（耗时、Token、轮次）',
    handler: 'handleSumCommand',
  },
] as const;

/** /sum 命令标识 */
export const SUM_COMMAND = '/sum';

/** 空数据时的友好提示文案 */
export const EMPTY_DAY_MESSAGE = '> 💡 今日暂无对话统计数据\n>\n> 开始与 AI 对话后，此处将展示当日累计的耗时、Token 消耗等统计信息。';

// ─── 命令处理回调类型 ──────────────────────────────

export type SumCommandHandler = () => Promise<void>;

// ─── 内部状态 ───────────────────────────────────────

let sumHandler: SumCommandHandler | null = null;

/**
 * 设置 /sum 命令的实际处理函数
 * 由 Engine 在初始化时注入
 */
export function setSumHandler(handler: SumCommandHandler | null): void {
  sumHandler = handler;
}

// ══════════════════════════════════════════════════════
// 命令识别与解析（供钩子层调用）
// ══════════════════════════════════════════════════════

/**
 * 判断输入文本是否为 /sum 命令
 *
 * 匹配规则：
 *   - "/sum"          → true
 *   - "/sum "         → true
 *   - "/sum  "        → true
 *   - "/SUM"          → true (大小写不敏感)
 *   - "/sum something" → true (忽略尾部参数)
 *   - "hello /sum"    → false (不在开头)
 *   - "/summary"      → false (不是 /sum)
 */
export function isSumCommand(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  return /^\s*\/sum\s*/i.test(input);
}

/**
 * 解析并执行 /sum 命令
 *
 * 由 chatLifecycleHook 在检测到用户发送 /sum 时调用。
 * 执行后会返回 { consumed: true } 表示消息已被消费，不应继续传递给大模型。
 *
 * @param input 用户原始输入文本
 * @returns { consumed: boolean } 是否成功消费了该命令
 */
export async function parseAndExecuteCommand(input: string): Promise<{ consumed: boolean }> {
  if (!isSumCommand(input)) {
    return { consumed: false };
  }

  logInfo(`[CommandInterceptor] /sum command intercepted from chat input`);

  if (sumHandler) {
    try {
      await sumHandler();
    } catch (e) {
      logError('/sum handler execution failed', e);
    }
  } else {
    logWarnSumNotReady();
  }

  // 告诉调用方：此消息已消费，不要发给大模型
  return { consumed: true };
}

// ══════════════════════════════════════════════════════
// 安装 / 卸载
// ══════════════════════════════════════════════════════

/** 已注册的 disposables */
const disposables: vscode.Disposable[] = [];

/**
 * 安装命令拦截器
 *
 * 注册内容：
 *   1. codebuddy.enhance.sum — 可通过命令面板触发的 /sum 命令
 *   2. CompletionItemProvider — 聊天面板中输入 "/" 时自动补全 /sum
 *
 * @returns 注册的 Disposable 数组（需在 deactivate 时统一 dispose）
 */
export function installCommandInterceptor(): vscode.Disposable[] {
  uninstallCommandInterceptor();

  // ── 1. 注册 /sum 处理命令（VS Code 命令面板可用） ──
  const sumCmd = vscode.commands.registerCommand(
    'codebuddy.enhance.sum',
    async () => {
      logInfo('[CommandInterceptor] /sum triggered via command palette');
      if (sumHandler) {
        await sumHandler();
      } else {
        logWarnSumNotReady();
      }
    }
  );
  disposables.push(sumCmd);

  // ── 2. 注册斜杠命令自动补全 ──
  try {
    registerSlashCommandCompletion();
  } catch (e) {
    logError('Failed to register slash command completion', e);
  }

  logInfo('[CommandInterceptor] Installed');
  return [...disposables];
}

/**
 * 卸载命令拦截器
 */
export function uninstallCommandInterceptor(): void {
  for (const d of disposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  disposables.length = 0;
  sumHandler = null;
  logInfo('[CommandInterceptor] Uninstalled');
}

// ══════════════════════════════════════════════════════
// 内部实现
// ══════════════════════════════════════════════════════

/**
 * 注册 /sum 到 VS Code 的自动补全/命令提示系统
 *
 * 通过 vscode.languages.registerCompletionItemProvider
 * 在聊天面板输入 "/" 时提供 /sum 建议
 */
function registerSlashCommandCompletion(): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(_document, _position, _token, _context) {
      const item = new vscode.CompletionItem(
        '/sum — 日统计汇总',
        vscode.CompletionItemKind.Text
      );
      item.insertText = '/sum ';
      item.detail = 'CodeBuddy Enhance: 显示当日对话统计汇总';
      item.documentation = new vscode.MarkdownString(
        '**CodeBuddy Enhance 日统计**\n\n' +
        '显示今日所有对话的总耗时、总 Token 消耗、对话轮次等汇总信息。\n\n' +
        '| 字段 | 说明 |\n|------|------|\n' +
        '| 对话轮次 | 当日正常完成的对话次数 |\n' +
        '| 总耗时 | 所有对话耗时累加 |\n' +
        '| 平均响应速度 | 平均流式输出速率 (chars/s) |\n' +
        '| 输入 Token | 累计 Prompt Tokens |\n' +
        '| 输出 Token | 累计 Completion Tokens |\n' +
        '| 总消耗 Token | Prompt + Completion 合计 |'
      );
      return [item];
    },
  };

  const schemes = ['codebuddy', 'chat', 'vscode-chat'];
  for (const scheme of schemes) {
    try {
      const d = vscode.languages.registerCompletionItemProvider(
        { scheme, language: '*' },
        provider,
        '/'
      );
      disposables.push(d);
    } catch { /* scheme 可能不可用 */ }
  }
}

function logWarnSumNotReady(): void {
  const msg = '[CommandInterceptor] /sum handler not set yet. Please ensure Engine is initialized.';
  console.warn(msg);
}
