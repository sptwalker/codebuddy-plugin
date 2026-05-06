# CodeBuddy Enhance 开发日志

> 项目：VS Code 扩展 — CodeBuddy 对话实时计时与统计
> 版本：v0.1.0 (dev)
> 最后更新：2026-05-06

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

### 📅 第六轮：官方 Hook 桥接与真实链路验证

**日期**：2026-05-06

**用户反馈**：
1. ❌ 在对话窗口提问后，输出窗口没有任何新信息
2. ✅ 修复配置后，在当前窗口发送真实 CodeBuddy 对话，测试窗口输出面板可看到对应事件
3. ⚠️ 本轮统计可生成，但 completion tokens / TTFT / 流式速度仍为空或 0

**核心修复**：

##### 1. 引入官方 Hook 文件桥接
- 新增 `src/hook/officialHookBridge.ts`
- 监听 `.codebuddy/codebuddy-enhance-events.jsonl`
- 将官方 Hook 事件转为内部事件模型：
  - `UserPromptSubmit` → `REQUEST_START`
  - `Stop` / `SubagentStop` → `RESPONSE_END`
  - `SessionEnd` → session change
  - `StopFailure` → request error

##### 2. 新增 Hook 脚本与配置
- 新增 `scripts/codebuddy-enhance-hook.cjs`，从 stdin 读取官方 Hook JSON 并写入 JSONL
- `.codebuddy/settings.json` 注册 `UserPromptSubmit` / `Stop` / `SubagentStop` / `SessionEnd` / `StopFailure`
- Hook command 改为绝对路径，规避 `$CODEBUDDY_PROJECT_DIR` 未展开导致脚本不执行

##### 3. 扩展入口接入
- `src/vsextension.ts` 中安装 / 卸载官方桥接：
  - `installOfficialHookBridge(context)`
  - `uninstallOfficialHookBridge()`
- `installHooks('webview')` 调整为 `installHooks('auto')`，保留 Webview / Document 诊断兜底
- 新增 `codebuddy.enhance.testTimer` 手动测试命令

##### 4. 日期与统计修复
- `src/utils/dateUtil.ts` 改为本地日期 `YYYY-MM-DD`，修复 UTC 日期错桶
- 真实日志确认写入 `date=2026-05-06`
- `src/core/engine.ts` 增强 E1/E3/TOKEN/PERSIST 日志，便于确认生命周期闭环

**验证结果**：
- ✅ 官方 Hook 链路已打通：真实 CodeBuddy 对话可触发 `UserPromptSubmit` 和 `Stop`
- ✅ 状态栏计时正常启动 / 结束
- ✅ 本轮统计表正常生成
- ✅ `/sum` 汇总命令可被识别并抑制为普通请求
- ✅ 日期写入已使用本地日期

**当前限制确认**：
- 官方 `Stop` payload 不包含 `transcript_path`
- Hook 环境变量未提供 transcript / chat / conversation 路径
- 因无回复正文和流式 chunk，暂无法准确计算：
  - completion tokens
  - TTFT
  - 流式输出速度
- Webview / Document watcher 只能监听扩展所在窗口；当前真实 CodeBuddy 在主窗口、Enhance 在测试窗口时，只有 JSONL Hook 可跨窗口工作

**下一步建议**：
1. 将开发版扩展打包为 VSIX 并安装到真实 CodeBuddy 所在窗口
2. 或在 Extension Development Host 测试窗口中同时运行 CodeBuddy
3. 在同窗口环境继续验证 Webview / Document fallback 是否能捕获回复正文或流式输出



## 三、产品定位与能力边界（v0.1.0 最终确认）

### ✅ 核心能力（已实现）

| 功能 | 状态 | 数据来源 |
|------|------|----------|
| 实时计时 (StatusBar) | ✅ 正常 | OfficialHookBridge E1/E3 |
| 本轮统计表格 | ✅ 正常 | E1/E3 时间戳 + prompt 文本 |
| /sum 日汇总 | ✅ 正常 | globalState 按日分桶聚合 |
| Prompt Token 估算 | ✅ 正常 | tiktoken (gpt-4o 编码) |
| 持久化存储 | ✅ 正常 | globalState，30天自动清理 |
| 日期本地化 | ✅ 已修复 | YYYY-MM-DD 本地时区 |

### ⚸️ 暂不可用（需 CodeBuddy 官方支持）

| 功能 | 状态 | 原因 |
|------|------|------|
| Completion Tokens | ❌ 0 | CodeBuddy Stop 事件不提供 `transcript_path` |
| TTFT（首Token延迟）| ❌ — | 无流式 chunk 数据 |
| 流式输出速度 | ❌ — | 同上 |
| AI 回复正文捕获 | ❌ 无法获取 | CodeBuddy 不将对话写入可读磁盘文件 |

### 根因确认（2026-05-06 深度调查）

经对 `CodeBuddyExtension/Data/` 目录的完整扫描：

```
CodeBuddyExtension/Data/<uuid>/CodeBuddyIDE/<uuid>/
├── check-point/   ← 嵌套 hash 目录，仅含空 meta.json (0 bytes)
│   └── <hash1>/<hash2>/meta.json
├── history/       ← 1 字节文件，进程锁定无法读取 (Access Denied)
│   └── <hash> (1 byte)
└── file-tree/     ← 仅包含我们自己的 codebuddy-enhance-events.jsonl
```

**结论**：`tencent-cloud.coding-copilot` 将 AI 对话数据以专有格式存储（加密或纯内存态），不输出标准 transcript JSONL 文件。Webview postMessage 拦截和 TextDocument 监听在同窗口测试中也未捕获到任何 Chat 相关消息——说明 CodeBuddy 使用自定义渲染机制，不走标准 VS Code Webview API。

**未来路径**：等待 CodeBuddy 官方在 Hook 事件中增加 `transcript_path` 或 `response_text` 字段。当前 transcript 发现逻辑已保留为轻量级防御性代码（仅检查顶层路径），一旦官方支持会自动生效。

### 🟡 次要问题（低优先级）
- [ ] Feature 1 计时器目前仅在 StatusBar 显示，尚未实现在 Chat 窗口文本行尾追加
- [ ] 多语言支持（当前仅中文）
- [ ] tiktoken 在 VSIX 安装场景下的模块加载路径需进一步验证

---

## 四、文件变更清单

| 文件 | 变更类型 | 主要改动 |
|------|----------|----------|
| `src/core/chatInjector.ts` | 重写 | WebviewPanel → Untitled Markdown Doc；注入锁 |
| `src/hook/officialHookBridge.ts` | 新增 | 监听官方 Hook JSONL；转换 `UserPromptSubmit` / `Stop` 等事件为内部生命周期事件 |
| `scripts/codebuddy-enhance-hook.cjs` | 新增 | 接收官方 Hook stdin payload；写入 `.codebuddy/codebuddy-enhance-events.jsonl`；记录环境诊断 |
| `.codebuddy/settings.json` | 新增/配置 | 注册 CodeBuddy 官方 Hooks；使用绝对路径调用 hook 脚本 |
| `src/hook/chatLifecycleHook.ts` | 大幅修改 | Command 禁用；DocWatch 诊断模式；周期性 Webview 扫描；去重锁；注入锁 |
| `src/core/engine.ts` | 参数与诊断增强 | CHUNK_TIMEOUT=10s；MIN_AUTO_END_LEN=5；本轮生命周期日志；token 解析日志 |
| `src/utils/dateUtil.ts` | 修复 | 使用本地日期 `YYYY-MM-DD`，修复 UTC 错桶 |
| `src/vsextension.ts` | 中度修改 | 接入 OfficialHookBridge；auto hooks；新增手动测试命令 |
| `src/hook/index.ts` | 小改 | 导出官方 Hook 桥接模块 |
| `package.json` | 小改 | keybinding when 条件移除；新增测试命令激活事件 |

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

### 决策 #4：采用官方 Hook JSONL 桥接
- **时间**：第六轮迭代
- **背景**：开发扩展运行在 Extension Development Host 测试窗口，真实 CodeBuddy 对话发生在主窗口，Webview / Document watcher 无法跨窗口捕获
- **实现**：`.codebuddy/settings.json` 注册官方 Hook，`scripts/codebuddy-enhance-hook.cjs` 写入 JSONL，`officialHookBridge.ts` 监听并转换事件
- **效果**：真实 CodeBuddy 对话可稳定触发 E1/E3，状态栏计时和统计表恢复可用
- **限制**：官方 Hook 当前不提供 `transcript_path` 和流式 chunk，无法直接计算 completion tokens / TTFT / 输出速度

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

*本日志由开发助手自动生成，记录了从初始构建到 v0.1.0 正式定稿的完整迭代过程。*
