// Turn a Claude Code session log into a readable markdown transcript.
//
// The raw .jsonl is ~10 MB, most of which is tool payloads: file contents echoed back, base64
// screenshots, thousands of lines of build output. None of that is the story. This keeps every
// human message and every word of assistant prose, and reduces each tool call to a single line
// naming what it did — which is what makes the process legible rather than exhausting.
//
//   node tools/transcript.mjs <session.jsonl> > TRANSCRIPT.md

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/transcript.mjs <session.jsonl>');
  process.exit(2);
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const out = [];
let toolRun = [];

const flushTools = () => {
  if (!toolRun.length) return;
  out.push('<details><summary><em>' + toolRun.length + ' tool call' +
    (toolRun.length === 1 ? '' : 's') + '</em></summary>\n');
  out.push('```');
  out.push(...toolRun);
  out.push('```');
  out.push('</details>\n');
  toolRun = [];
};

const oneLine = (s, n = 160) =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const m = e.message;
  if (!m || !m.role) continue;

  const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];

  if (m.role === 'user') {
    // Skip tool results and the system-reminder scaffolding; keep what the human actually typed.
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '[background task completed]')
      .trim();
    if (!text || text.startsWith('[SYSTEM NOTIFICATION')) continue;
    flushTools();
    out.push('\n---\n');
    out.push('### 🧑 Alan\n');
    out.push(text + '\n');
    continue;
  }

  if (m.role === 'assistant') {
    for (const p of parts) {
      if (p.type === 'text' && p.text?.trim()) {
        flushTools();
        out.push(p.text.trim() + '\n');
      } else if (p.type === 'tool_use') {
        const i = p.input || {};
        const label =
          i.description ||
          i.command ||
          i.file_path ||
          i.prompt ||
          i.query ||
          i.title ||
          JSON.stringify(i).slice(0, 120);
        toolRun.push(`${p.name.padEnd(10)} · ${oneLine(label)}`);
      }
    }
  }
}
flushTools();

const header = `# Transcript — building OPERATION NAPTIME

The complete conversation that produced this project, from a photograph of a living room to a
deployed game. Assistant prose is verbatim. Tool calls are collapsed to one line each — the raw
log is ~10 MB and almost all of it is build output and file echoes.

Written in Spanish, because that is how the conversation happened.

---
`;

process.stdout.write(header + out.join('\n') + '\n');
