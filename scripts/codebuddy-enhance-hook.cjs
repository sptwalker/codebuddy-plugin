#!/usr/bin/env node
/**
 * codebuddy-enhance-hook.cjs
 *
 * CodeBuddy 官方 Hook 入口脚本。
 * 从 stdin 接收官方 Hook JSON payload，写入 JSONL 事件文件供扩展监听。
 *
 * 功能：
 * - Stop/SubagentStop 事件时，轻量级搜索 transcript 文件（最佳尝试）
 * - 收集诊断环境变量便于调试
 *
 * 已知限制（2026-05-06 确认）：
 *   CodeBuddy (tencent-cloud.coding-copilot) 不将 AI 回复正文写入磁盘。
 *   其数据存储在专有格式中（加密或内存态），无标准 transcript 文件。
 *   因此 completion tokens / TTFT / 流式速度 暂不可用，待官方支持。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 环境变量诊断 ──────────────────────────────────────────────
function pickDiagnosticEnv() {
  const result = {};
  const keywords = [
    'CODEBUDDY', 'CLAUDE', 'TRANSCRIPT', 'SESSION',
    'CHAT', 'CONVERSATION', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'XDG', 'HOME'
  ];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (keywords.some((kw) => key.toUpperCase().includes(kw))) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Transcript 文件发现（轻量级最佳尝试） ─────────────────
// 已知：CodeBuddy 不输出可读的 transcript。此函数仅作为防御性搜索，
// 未来如果 CodeBuddy 版本升级支持了 transcript 输出，此处会自动生效。

/**
 * 在常见路径下搜索 transcript 文件（仅检查顶层，不做深度递归）
 */
function discoverTranscriptPath(sessionId, cwd) {
  if (!sessionId) return null;

  const homeDir = os.homedir();
  const localData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

  // 候选路径：Claude Code 标准位置 + 项目 .claude 目录
  const candidatePaths = [
    path.join(homeDir, '.claude', 'projects', `${sessionId}.jsonl`),
    path.join(cwd || '', '.claude', `${sessionId}.jsonl`),
    path.join(localData, 'CodeBuddyExtension', 'Data'),
  ].filter(Boolean);

  for (const p of candidatePaths) {
    try {
      // 仅检查直接文件匹配，不递归搜索（性能考虑）
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size > 100) return p;
      }
      // 如果是目录（如 CodeBuddyExtension/Data），跳过——已知其中无可读 transcript
    } catch { /* skip */ }
  }

  return null;
}

// ─── 主函数 ──────────────────────────────────────────────────────
function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = raw.trim() ? JSON.parse(raw) : {};
      const projectDir = process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
      const outDir = path.join(projectDir, '.codebuddy');
      fs.mkdirSync(outDir, { recursive: true });

      // ─── Stop 事件增强：主动发现 transcript ───────────────
      const eventName = input.hook_event_name || '';
      let discoveredTranscript = null;

      if (eventName === 'Stop' || eventName === 'SubagentStop') {
        // 策略 1: 使用 input 中已有的 transcript_path
        if (input.transcript_path && fs.existsSync(input.transcript_path)) {
          discoveredTranscript = input.transcript_path;
        }

        // 策略 2: 轻量级搜索（仅顶层匹配，不递归）
        if (!discoveredTranscript && input.session_id) {
          discoveredTranscript = discoverTranscriptPath(input.session_id, projectDir);
        }

        if (discoveredTranscript) {
          input._discovered_transcript_path = discoveredTranscript;
        }
      }

      // ─── 构建富化输出 ─────────────────────────────────────
      const enriched = {
        ...input,
        __enhance_hook_diag: {
          argv: process.argv.slice(2),
          env: pickDiagnosticEnv(),
          _discovery_result: discoveredTranscript ? 'found' : undefined,
        },
      };

      fs.appendFileSync(
        path.join(outDir, 'codebuddy-enhance-events.jsonl'),
        JSON.stringify(enriched) + '\n',
        'utf8'
      );
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    } catch (err) {
      process.stderr.write(`[codebuddy-enhance-hook] ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });
}

main();
