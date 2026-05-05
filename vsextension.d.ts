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
/**
 * 扩展激活入口（VS Code 自动调用）
 */
export declare function activate(context: vscode.ExtensionContext): Promise<void>;
/**
 * 扩展销毁入口（VS Code 自动调用，窗口关闭或插件禁用时触发）
 *
 * 清理顺序（防止依赖倒置）：
 *   命令 → 钩子 → 引擎(含输出通道) → 全局定时器兜底
 */
export declare function deactivate(): void;
//# sourceMappingURL=vsextension.d.ts.map