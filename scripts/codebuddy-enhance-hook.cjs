#!/usr/bin/env node
/**
 * codebuddy-enhance-hook.cjs
 *
 * CodeBuddy 官方 Hook 入口脚本。
 * 从 stdin 接收官方 Hook JSON payload，写入 JSONL 事件文件供扩展监听。
 *
 * 增强功能：
 * - Stop/SubagentStop 事件时，根据 session_id 主动搜索 transcript 文件
 * - 收集诊断环境变量便于调试
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

// ─── Transcript 文件发现 ────────────────────────────────────────

/**
 * 根据session_id在常见路径下搜索transcript文件。
 * CodeBuddy/Claude Code通常将transcript以.jsonl格式存储。
 */
function discoverTranscriptPath(sessionId, cwd) {
  if (!sessionId) return null;

  const homeDir = os.homedir();
  const userData = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData');
  const localData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

  // 构建候选搜索目录列表
  const candidateDirs = [
    // Claude Code 标准路径: ~/.claude/projects/<project-hash>/
    path.join(homeDir, '.claude', 'projects'),
    // CodeBuddy 可能的路径
    path.join(homeDir, '.codebuddy'),
    path.join(userData, 'CodeBuddy'),
    path.join(localData, 'CodeBuddy'),
    // 项目级路径
    cwd && path.join(cwd, '.claude'),
    cwd && path.join(cwd, '.codebuddy'),
    // 全局数据目录
    path.join(localData, 'claude'),
  ].filter(Boolean);

  // 可能的文件名模式
  const fileNamePatterns = [
    `${sessionId}.jsonl`,
    `${sessionId}.json`,
    sessionId,
  ];

  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      // 直接匹配：sessionId 作为文件名
      for (const pattern of fileNamePatterns) {
        const directPath = path.join(dir, pattern);
        if (fs.existsSync(directPath)) {
          const stat = fs.statSync(directPath);
          if (stat.isFile() && stat.size > 0) {
            return directPath;
          }
        }
      }

      // 子目录递归搜索（限制深度为2层）
      const maxDepth = 2;
      const searchQueue = [{ dir, depth: 0 }];
      while (searchQueue.length > 0) {
        const { dir: currentDir, depth } = searchQueue.shift();

        if (depth >= maxDepth) continue;
        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isFile()) {
              // 检查文件名是否包含 session_id
              if (entry.name.includes(sessionId) && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
                const stat = fs.statSync(fullPath);
                if (stat.size > 0) return fullPath;
              }
              // 也检查是否是常见的 transcript 文件名
              if ((entry.name === 'transcript.jsonl' || entry.name === 'conversation.jsonl' || entry.name === 'chat.jsonl')) {
                const stat = fs.statSync(fullPath);
                if (stat.size > 0) return fullPath;
              }
            } else if (entry.isDirectory()) {
              searchQueue.push({ dir: fullPath, depth: depth + 1 });
            }
          }
        } catch { /* skip permission errors */ }
      }
    } catch { /* skip */ }
  }

  return null;
}

/**
 * 扫描项目目录下的 .claude/ 子目录寻找最新修改的 transcript
 */
function findLatestTranscriptInProject(cwd) {
  if (!cwd) return null;

  const claudeDir = path.join(cwd, '.claude');
  try {
    if (!fs.existsSync(claudeDir)) return null;

    let latestPath = null;
    let latestTime = 0;

    function scanDir(dir, depth) {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (
            entry.name.endsWith('.jsonl') &&
            (entry.name.includes('transcript') || entry.name.includes('session'))
          ) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.mtimeMs > latestTime && stat.size > 1024) {
                latestTime = stat.mtimeMs;
                latestPath = fullPath;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    scanDir(claudeDir, 0);
    return latestPath;
  } catch { /* skip */ }

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

        // 策略 2: 根据 session_id 搜索
        if (!discoveredTranscript && input.session_id) {
          discoveredTranscript = discoverTranscriptPath(input.session_id, projectDir);
        }

        // 策略 3: 在项目 .claude/ 目录查找最近修改的 transcript
        if (!discoveredTranscript) {
          discoveredTranscript = findLatestTranscriptInProject(projectDir);
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
