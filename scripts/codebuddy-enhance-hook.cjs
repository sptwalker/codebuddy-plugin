#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function pickDiagnosticEnv() {
  const result = {};
  const keywords = ['CODEBUDDY', 'CLAUDE', 'TRANSCRIPT', 'SESSION', 'CHAT', 'CONVERSATION'];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (keywords.some((kw) => key.toUpperCase().includes(kw))) {
      result[key] = value;
    }
  }
  return result;
}

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

      const enriched = {
        ...input,
        __enhance_hook_diag: {
          argv: process.argv.slice(2),
          env: pickDiagnosticEnv(),
        },
      };

      fs.appendFileSync(path.join(outDir, 'codebuddy-enhance-events.jsonl'), JSON.stringify(enriched) + '\n', 'utf8');
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    } catch (err) {
      process.stderr.write(`[codebuddy-enhance-hook] ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });
}

main();
