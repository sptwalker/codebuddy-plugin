/**
 * CodeBuddy Enhance — VS Code 扩展入口
 *
 * activate  初始化流程：
 *   1. 初始化日志输出通道
 *   2. 初始化主引擎（绑定事件处理器 + 注册 /sum handler）
 *   3. 安装事件钩子层（Webview / Command / Document 三策略）
 *   4. 安装命令拦截器（/sum 注册 + 补全）
 *   5. 执行启动时数据治理（过期清理）
 *
 * deactivate 销毁流程（逆序）：
 *   1. 卸载命令拦截器
 *   2. 卸载事件钩子
 *   3. 销毁引擎（定时器 + 事件监听 + 输出通道）
 *   4. 全局定时器兜底清理
 */

import * as vscode from 'vscode';
import { initEngine, disposeEngine } from './core/engine';
import { installHooks, uninstallHooks } from './hook/chatLifecycleHook';
import { installOfficialHookBridge, uninstallOfficialHookBridge } from './hook/officialHookBridge';
import { eventHookManager } from './hook/eventHookManager';
import { installCommandInterceptor, uninstallCommandInterceptor } from './hook/commandInterceptor';
import { initInjector, disposeInjector } from './core/chatInjector';
import {
  logInfo, logError, logWarn, logDebug, showOutputChannel,
} from './utils/errorGuard';
import { disposeAllTimers } from './utils/cleanup';
import { cleanupOldBuckets } from './storage/storageManager';

/** 插件激活状态标记 */
let _activated = false;

/**
 * 扩展激活入口（VS Code 自动调用）
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (_activated) {
    logWarn('[Entry] Already activated, skipping');
    return;
  }

  try {
    logInfo('═══════════════════════════════════════════');
    logInfo(' CodeBuddy Enhance v0.1.0 activating...');
    logInfo('═══════════════════════════════════════════');

    // ── Step 0: 初始化 UI 注入通道（StatusBar） ────────
    initInjector();

    // ── Step 1: 初始化主引擎 ─────────────────────
    // 绑定 E1-E5 事件处理器，注册 /sum 命令回调
    // 引擎内部会初始化 OutputChannel 和配置持久化
    initEngine(context);

    // ── Step 2: 安装事件钩子层 ────────────────────
    // 官方 Hook 文件桥接为主，Webview 监听作为 IDE 内兜底。
    installOfficialHookBridge(context);
    installHooks('auto');

    // ── Step 3: 安装 /sum 命令拦截器 ──────────────
    //   - codebuddy.enhance.sum 命令注册到插件生命周期
    //   - codebuddy.enhance.showOutput 命令打开日志面板
    //   - CompletionItemProvider 提供 "/" 自动补全
    const cmdDisposables = installCommandInterceptor();

    // 注册 showOutput 命令（打开输出通道）
    const showOutputCmd = vscode.commands.registerCommand(
      'codebuddy.enhance.showOutput',
      () => { showOutputChannel(); }
    );
    cmdDisposables.push(showOutputCmd);
    // 注册手动测试命令：直接触发 E1，验证 Engine + StatusBar 是否正常
    const testTimerCmd = vscode.commands.registerCommand(
      'codebuddy.enhance.testTimer',
      () => {
        const requestId = `manual-test-${Date.now()}`;
        logInfo(`[Entry] Manual test timer command invoked | requestId=${requestId}`);
        eventHookManager.emitRequestStart({
          timestamp: performance.now(),
          userMessage: 'manual test',
          requestId,
        });
      }
    );
    cmdDisposables.push(testTimerCmd);



    // 注册 showStatsPanel 命令（打开/聚焦统计面板 + 恢复历史记录）
    const showStatsCmd = vscode.commands.registerCommand(
      'codebuddy.enhance.showStatsPanel',
      async () => {
        try {
          const { getOrCreateStatsPanel } = await import('./core/statsWebviewPanel');
          await getOrCreateStatsPanel(context);
        } catch (e) { logError('[Entry] showStatsPanel failed', e); }
      }
    );
    cmdDisposables.push(showStatsCmd);

    // 注册 closeStatsPanel 命令（关闭统计文档）
    const closeStatsCmd = vscode.commands.registerCommand(
      'codebuddy.enhance.closeStatsPanel',
      () => {
        try {
          import('./core/statsWebviewPanel').then(({ closeStatsPanel }) => {
            closeStatsPanel();
          });
        } catch { /* ignore */ }
      }
    );
    cmdDisposables.push(closeStatsCmd);

    for (const d of cmdDisposables) {
      context.subscriptions.push(d);
    }
    logInfo(`[Entry] Command interceptor installed (${cmdDisposables.length} disposables)`);

    // ── Step 4: 启动数据治理 — 清理过期历史 ────────
    // 每次激活时执行一次自动清理（默认保留 30 天）
    try {
      const removed = await cleanupOldBuckets(context, 30);
      if (removed > 0) {
        logInfo(`[Entry] Auto-cleanup: removed ${removed} expired daily buckets (>30 days)`);
      } else {
        logDebug('[Entry] Auto-cleanup: no expired data to remove');
      }
    } catch (e) {
      logWarn('[Entry] Auto-cleanup failed (non-critical)', e);
    }

    _activated = true;
    logInfo('✅ CodeBuddy Enhance activated successfully');
    logInfo('═══════════════════════════════════════════');
  } catch (e) {
    logError('❌ Failed to activate CodeBuddy Enhance', e);
  }
}

/**
 * 扩展销毁入口（VS Code 自动调用，窗口关闭或插件禁用时触发）
 *
 * 清理顺序（防止依赖倒置）：
 *   命令 → 钩子 → 引擎(含输出通道) → 全局定时器兜底
 */
export function deactivate(): void {
  if (!_activated) return;

  try {
    logInfo('CodeBuddy Enhance deactivating...');

    // 1. 卸载命令拦截器
    uninstallCommandInterceptor();

    // 2. 卸载事件钩子
    uninstallOfficialHookBridge();
    uninstallHooks();

    // 3. 销毁 UI 注入通道（StatusBar）
    disposeInjector();

    // 4. 销毁引擎（含：停止计时、清除 Engine 定时器、解绑事件、销毁输出通道）
    disposeEngine();

    // 4. 全局定时器兜底清理（确保无遗漏）
    const remaining = disposeAllTimers();
    if (remaining > 0) {
      logWarn(`[Entry] ${remaining} timers still active after full dispose`);
    }

    logInfo('🔌 CodeBuddy Enhance deactivated');
    _activated = false;
  } catch (e) {
    logError('Error during deactivation', e);
  }
}
