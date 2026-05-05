"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const engine_1 = require("./core/engine");
const chatLifecycleHook_1 = require("./hook/chatLifecycleHook");
const commandInterceptor_1 = require("./hook/commandInterceptor");
const errorGuard_1 = require("./utils/errorGuard");
const cleanup_1 = require("./utils/cleanup");
const storageManager_1 = require("./storage/storageManager");
/** 插件激活状态标记 */
let _activated = false;
/**
 * 扩展激活入口（VS Code 自动调用）
 */
async function activate(context) {
    if (_activated) {
        (0, errorGuard_1.logWarn)('[Entry] Already activated, skipping');
        return;
    }
    try {
        (0, errorGuard_1.logInfo)('═══════════════════════════════════════════');
        (0, errorGuard_1.logInfo)(' CodeBuddy Enhance v0.1.0 activating...');
        (0, errorGuard_1.logInfo)('═══════════════════════════════════════════');
        // ── Step 1: 初始化主引擎 ─────────────────────
        // 绑定 E1-E5 事件处理器，注册 /sum 命令回调
        // 引擎内部会初始化 OutputChannel 和配置持久化
        (0, engine_1.initEngine)(context);
        // ── Step 2: 安装事件钩子层 ────────────────────
        // 三策略：Webview postMessage 拦截 > Command 拦截 > Document 监听
        (0, chatLifecycleHook_1.installHooks)('auto');
        // ── Step 3: 安装 /sum 命令拦截器 ──────────────
        //   - codebuddy.enhance.sum 命令注册到插件生命周期
        //   - CompletionItemProvider 提供 "/" 自动补全
        const cmdDisposables = (0, commandInterceptor_1.installCommandInterceptor)();
        for (const d of cmdDisposables) {
            context.subscriptions.push(d);
        }
        (0, errorGuard_1.logInfo)(`[Entry] Command interceptor installed (${cmdDisposables.length} disposables)`);
        // ── Step 4: 启动数据治理 — 清理过期历史 ────────
        // 每次激活时执行一次自动清理（默认保留 30 天）
        try {
            const removed = await (0, storageManager_1.cleanupOldBuckets)(context, 30);
            if (removed > 0) {
                (0, errorGuard_1.logInfo)(`[Entry] Auto-cleanup: removed ${removed} expired daily buckets (>30 days)`);
            }
            else {
                (0, errorGuard_1.logDebug)('[Entry] Auto-cleanup: no expired data to remove');
            }
        }
        catch (e) {
            (0, errorGuard_1.logWarn)('[Entry] Auto-cleanup failed (non-critical)', e);
        }
        _activated = true;
        (0, errorGuard_1.logInfo)('✅ CodeBuddy Enhance activated successfully');
        (0, errorGuard_1.logInfo)('═══════════════════════════════════════════');
    }
    catch (e) {
        (0, errorGuard_1.logError)('❌ Failed to activate CodeBuddy Enhance', e);
    }
}
/**
 * 扩展销毁入口（VS Code 自动调用，窗口关闭或插件禁用时触发）
 *
 * 清理顺序（防止依赖倒置）：
 *   命令 → 钩子 → 引擎(含输出通道) → 全局定时器兜底
 */
function deactivate() {
    if (!_activated)
        return;
    try {
        (0, errorGuard_1.logInfo)('CodeBuddy Enhance deactivating...');
        // 1. 卸载命令拦截器
        (0, commandInterceptor_1.uninstallCommandInterceptor)();
        // 2. 卸载事件钩子
        (0, chatLifecycleHook_1.uninstallHooks)();
        // 3. 销毁引擎（含：停止计时、清除 Engine 定时器、解绑事件、销毁输出通道）
        (0, engine_1.disposeEngine)();
        // 4. 全局定时器兜底清理（确保无遗漏）
        const remaining = (0, cleanup_1.disposeAllTimers)();
        if (remaining > 0) {
            (0, errorGuard_1.logWarn)(`[Entry] ${remaining} timers still active after full dispose`);
        }
        (0, errorGuard_1.logInfo)('🔌 CodeBuddy Enhance deactivated');
        _activated = false;
    }
    catch (e) {
        (0, errorGuard_1.logError)('Error during deactivation', e);
    }
}
//# sourceMappingURL=vsextension.js.map