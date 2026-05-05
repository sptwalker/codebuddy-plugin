# CodeBuddy Enhance 开发日志

> 项目：VS Code 扩展 — CodeBuddy 对话实时计时与统计
> 版本：v0.1.0 (dev)
> 最后更新：2026-05-05

---

## 一、项目概述

### 核心功能
1. **Feature 1 — 实时计时**：AI 输出期间在状态栏显示 ⏱ x.xs 计时器
2. **Feature 2 — 统计表格**：对话结束后生成 Markdown 统计表（Untitled Document）
3. **Feature 3 — /sum 汇总**：当日全日统计总表命令

### 技术架构
- **事件驱动模型**：E1(RequestStart) → E2(StreamChunk) → E3(ResponseEnd) + E4(SessionChange) + E5(RequestError)
- **三策略事件捕获**：
  - A. Webview postMessage 拦截（主要方案）
  - B. Command 注册拦截（已禁用）
  - C. TextDocument 变更监听（降级兜底）
- **UI 注入通道**：StatusBar（实时）+ Untitled Markdown Doc（统计表）

---

## 二、开发迭代记录

### 📅 第一轮：初始构建与基础问题修复

**日期**：2026-05-05

**任务**：执行编译和重启测试准备

**完成内容**：
- ✅ TypeScript 编译通过（0 错误）
- ✅ F5 调试模式准备就绪

---

### 📅 第二轮：UI 层面三大问题修复

**用户反馈**：
1. ❌ 统计面板上始终空白
2. ❌ Ctrl+Shift+S 快捷键无效  
3. ❌ 希望计时输出在 Chat 窗口文本结尾，而非独立面板

**根因分析与修复**：

#### 问题 1 & 3：WebviewPanel 始终空白
- **原因**：WebviewPanel 方案无法正确渲染内容到 VS Code 内置 Chat 面板
- **方案**：完全放弃 WebviewPanel，改用 **Untitled Markdown Document**（编辑器区域展示）
- **涉及文件**：
  - `src/core/chatInjector.ts`：移除 `statsWebviewPanel` 依赖，新增 `_statsDoc` 状态变量，实现 `createNewStatsDocument()` / `appendToStatsDocument()`
  - `src/vsextension.ts`：移除 statsPanel 导入，重写 show/close 命令使用动态 import
  - `src/hook/chatLifecycleHook.ts`：移除对 statsWebviewPanel 的引用

#### 问题 2：Ctrl+Shift+S 无效
- **原因**：package.json 中 keybinding 的 `when` 条件过于严格（`editorTextFocus || chatHasInputFocus`）
- **修复**：移除 when 条件，改为全局生效
- **涉及文件**：`package.json`

**代码变更摘要**：
```typescript
// chatInjector.ts — 新增 Untitled Doc 方案
let _statsDoc: vscode.TextDocument | null = null;

function createNewStatsDocument(header: string, content: string): void {
  vscode.workspace.openTextDocument({
    content: fullContent,
    language: 'markdown'
  }).then(doc => {
    _statsDoc = doc;
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  });
}
```

---

### 📅 第三轮：状态栏计时器与虚假统计问题

**用户反馈**：
1. ❌ 右下角实时计时开始后马上消失
2. ❌ 对话尚未发生已在统计面板输出统计信息
3. ❌ 对话窗口里看不到任何计时信息

**根因分析**：

#### 问题 1：计时器立即消失
- **原因**：`CHUNK_TIMEOUT_MS = 3000` 太短（AI 思考阶段常超 3 秒），导致过早触发 E3 自动结束
- **修复**：
  - 将 `CHUNK_TIMEOUT_MS` 从 **3000ms** 提升至 **10000ms**
  - 新增 `MIN_AUTO_END_RESPONSE_LEN = 5` 安全守卫：累计文本少于 5 字符时不触发自动结束

#### 问题 2：启动即产生虚假统计
- **原因**：auto 策略的三路并行钩子同时触发 E1，导致重复请求开始事件
- **修复**：添加 **500ms 去重锁** (`shouldEmitRequestStart()` 函数)

**涉及文件**：
- `src/core/engine.ts`：第 347 行 CHUNK_TIMEOUT 改为 10000，新增 MIN_AUTO_END_RESPONSE_LEN
- `src/hook/chatLifecycleHook.ts`：新增 `shouldEmitRequestStart()` 去重逻辑，三处 emitRequestStart 调用点均加入守卫

**代码变更摘要**：
```typescript
// engine.ts — 超时参数调整
const CHUNK_TIMEOUT_MS = 10000; // 原 3000ms
const MIN_AUTO_END_RESPONSE_LEN = 5; // 新增安全守卫

// chatLifecycleHook.ts — 去重锁
let _requestStartDedupTs = 0;
const REQUEST_DEBOUNCE_MS = 500;

function shouldEmitRequestStart(): boolean {
  const now = Date.now();
  if (now - _requestStartDedupTs < REQUEST_DEBOUNCE_MS) return false;
  _requestStartDedupTs = now;
  return true;
}
```

---

### 📅 第四轮：无限循环与事件风暴

**用户反馈**：
1. ❌ 右下角计时消失后不再出现
2. ❌ 统计记录未伴随对话产生，系统启动后无任何输入即输出一轮统计
3. ❌ 对话窗口依然看不到计时信息

**关键发现：事件循环触发链路**

```
E3(结束) 
→ injectTurnSummaryTable() 
→ createNewStatsDocument(untitled doc) 
→ Document Watcher(onDidChangeTextDocument) 捕获变更
→ emitRequestStart(假 E1!) 
→ 启动计时 → timeout → E3 
→ 循环 ♻️
```

**修复方案**：

##### 1. 全局注入锁机制
- 在 `chatLifecycleHook.ts` 新增 `_isInjectingStatsDoc` 全局布尔锁
- 导出 `beginStatsDocInjection()` / `endStatsDocInjection()` 供 `chatInjector.ts` 调用
- Document Watcher 在锁激活期间跳过所有文档变更

##### 2. Scheme 排除列表
- Document Watcher 排除以下 URI scheme：`untitled`, `file`, `output`, `vscode-webview`

##### 3. Engine 清理增强
- E1 入口处调用 `clearDisplay()` 清理上一轮残留的状态栏状态
- 新增 ★★★ 显著标记便于日志定位

**涉及文件**：
- `src/hook/chatLifecycleHook.ts`：第 62-67 行注入锁，第 370-374 行 scheme 排除
- `src/core/chatInjector.ts`：第 195-229 行 try/finally 包裹注入锁获取/释放
- `src/core/engine.ts`：第 244 行 clearDisplay()，第 246 行 ★★★ 日志标记

**代码变更摘要**：
```typescript
// chatLifecycleHook.ts — 注入锁
let _isInjectingStatsDoc = false;
export function beginStatsDocInjection(): void { _isInjectingStatsDoc = true; }
export function endStatsDocInjection(): void { _isInjectingStatsDoc = false; }

// Document Watcher 排除逻辑
if (_isInjectingStatsDoc) return;
if (doc.uri.scheme === 'file') return;

// chatInjector.ts — 加锁保护
function appendToStatsDocument(markdown: string): void {
  try {
    beginStatsDocInjection(); // 上锁
    // ... 写入操作 ...
  } finally {
    endStatsDocInjection(); // 解锁
  }
}
```

---

### 📅 第五轮（当前）：全面静默诊断

**用户反馈**：
1. ❌ 右下角没有任何计时信息
2. ❌ 对话之后也没有产生任何统计信息

**根因深度分析**：

经过四轮迭代发现，**三种事件捕获策略全部存在严重问题**：

| 策略 | 状态 | 问题 |
|------|------|------|
| A. Webview 拦截 | ⚠️ 仅扫描一次 | Chat 面板可能在 activate 之后才打开 |
| B. Command 拦截 | ❌ 已禁用 | 猜测的命令名不匹配 VS Code Chat API，且会覆盖原始命令导致消息无法发送 |
| C. Document 监听 | ⚠️ 过于严格 | scheme 排除列表可能过滤掉了真正的 Chat 文档 |

**本轮修复**：

##### 1. Command Interceptor 完全禁用
- `installHooks('command')` 和 auto 模式下的 Command 拦截均跳过
- 日志输出明确警告：`Command interceptor DISABLED (blocks chat send)`

##### 2. Document Watcher 切换为诊断模式
- **放宽目标匹配**：增加 `vscode-chat`, `chat-sideloading-editor` 等 scheme
- **全面诊断日志**：所有非 file 文档变更均输出 `[DocWatch] change | scheme="..."` INFO 日志
- 目的：通过日志确定 VS Code Chat 实际使用的文档类型

##### 3. Webview 拦截增强为周期性扫描
- 从单次 `scanAndHookWebviews()` 改为每 **3 秒**执行一次
- 使用原生 `setInterval`（避免 safeSetInterval 不存在的问题）
- 扫描范围扩大：匹配包含 `codebuddy/chat/ai/copilot/assistant` 的 viewType

##### 4. Engine E1 入口显著标记
- 新增 ★★★ 三星前缀：`[Engine] ★★★ E1 REQUEST_START RECEIVED`
- 便于在大量日志中快速定位是否收到过 E1 事件

**编译错误修复记录**：

| 错误 | 修复 |
|------|------|
| `logWarn` 未导入 | 添加到 errorGuard 导入列表 |
| `safeSetInterval` 不存在 | 改用原生 `setInterval` |
| `setVisibleTextEditors` API 不存在 | 改用 `workbench.action.closeActiveEditor` 命令 |
| `editor.viewColumn as unknown as vscode.Webview` 类型错误 | 简化扫描循环逻辑 |

**最终编译结果**：✅ **0 errors**

---

## 三、待解决问题

### 🔴 关键问题：Chat 文档类型未知
当前最大的不确定性是 **VS Code 内置 Chat 面板使用的具体 URI scheme / 文档类型**。

**下一步诊断计划**：
1. 用户执行 F5 重启扩展
2. 打开 Output Log（CodeBuddy Enhance 输出通道）
3. 发送一条 Chat 消息
4. 观察以下日志输出：
   - `[DocWatch] change | scheme="..."` — 确定 Chat 文档的实际 scheme
   - `[ChatLifecycleHook] Webview msg type="..."` — 确定 Webview 消息协议
   - `[Engine] ★★★ E1 REQUEST_START RECEIVED` — 确认是否成功触发 E1

### 🟡 次要问题
- [ ] Feature 1 计时器目前仅在 StatusBar 显示，尚未实现在 Chat 窗口文本行尾追加
- [ ] /sum 命令补全功能待验证
- [ ] 多语言支持（当前仅中文）

---

## 四、文件变更清单

| 文件 | 变更类型 | 主要改动 |
|------|----------|----------|
| `src/core/chatInjector.ts` | 重写 | WebviewPanel → Untitled Markdown Doc；注入锁 |
| `src/hook/chatLifecycleHook.ts` | 大幅修改 | Command 禁用；DocWatch 诊断模式；周期性 Webview 扫描；去重锁；注入锁 |
| `src/core/engine.ts` | 参数调整 | CHUNK_TIMEOUT=10s；MIN_AUTO_END_LEN=5；clearDisplay on E1；★★★日志 |
| `src/vsextension.ts` | 中度修改 | 移除 statsPanel；动态 import；show/close 命令重写 |
| `package.json` | 小改 | keybinding when 条件移除 |

---

## 五、技术决策记录

### 决策 #1：放弃 WebviewPanel
- **时间**：第二轮迭代
- **背景**：WebviewPanel 内容始终空白，无法嵌入到 Chat 面板
- **替代方案**：Untitled Markdown Document（ViewColumn.Beside）
- **理由**：VS Code 编辑器区域的原生 UI 组件更稳定可靠

### 决策 #2：禁用 Command Interceptor
- **时间**：第五轮迭代
- **背景**：猜测的命令名覆盖了原始命令，导致 Chat 消息无法发送
- **风险**：失去一种可能的事件捕获途径
- **缓解措施**：依赖 Webview + Document 双策略兜底

### 决策 #3：全局注入锁防循环
- **时间**：第四轮迭代
- **背景**：统计文档创建被 Document Watcher 捕获形成无限循环
- **实现**：`_isInjectingStatsDoc` 布尔锁 + try/finally 保护
- **效果**：彻底阻断 E3→DocWatch→E1 循环链路

---

## 六、编译与部署说明

### 编译命令
```bash
npm run compile
# 或
tsc -p ./
```

### 测试步骤
1. 按 F5 启动 Extension Development Host
2. 打开 View → Output → 选择 "CodeBuddy Enhance"
3. 打开 VS Code 侧边栏 Chat 面板
4. 发送一条消息给 AI
5. 观察输出日志中的诊断信息

### Git 提交建议
```bash
git add .
git commit -m "feat: v0.1.0-dev — 事件捕获系统重构与诊断增强

主要变更：
- 废弃 WebviewPanel，改用 Untitled Markdown Document 展示统计
- 禁用 Command Interceptor（阻塞 Chat 发送）
- Document Watcher 切换诊断模式（宽松匹配 + 全面日志）
- Webview 拦截升级为周期性扫描（3s间隔）
- 新增注入锁机制防止事件循环
- 调整 CHUNK_TIMEOUT 至 10s + MIN_AUTO_END_RESPONSE_LEN 守卫
- E1 入口新增 ★★★ 显著日志标记

待解决：VS Code Chat 实际文档类型/URI scheme 待诊断确认"
git push origin main
```

---

*本日志由开发助手自动生成，记录了从初始构建到第五轮诊断的完整迭代过程。*
