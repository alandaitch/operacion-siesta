// Render a Claude Code session log as a self-contained HTML page that looks like the terminal it
// happened in: the ⏺ tool bullets, the ⎿ result gutters, the > user prompts, the coral accent.
//
// Everything is inlined — no CDN, no fonts, no scripts beyond a collapse toggle — so the file can
// be opened from disk, committed, or served as a GitHub Page.
//
//   node tools/transcript-html.mjs <session.jsonl> [--out docs/transcript.html] [--max-result 14]

import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const out = String(flag('out', 'docs/transcript.html'));
const MAX_RESULT_LINES = Number(flag('max-result', 14));
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/transcript-html.mjs <session.jsonl> [--out file.html]');
  process.exit(2);
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── a small markdown renderer ──────────────────────────────────────────────────────────────────
// Deliberately minimal: the assistant's prose uses bold, inline code, links, lists, tables,
// headers and fenced code, and nothing else.
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/(^|\s)(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return t;
}

function markdown(src) {
  const lines = String(src).split('\n');
  const html = [];
  let i = 0;
  let list = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Tables: a header row followed by a |---| separator.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length + 1;
      html.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      i++;
      continue;
    }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${inline(ol[2])}</li>`);
      i++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) { closeList(); html.push('<hr>'); i++; continue; }
    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i]))
      para.push(lines[i++]);
    html.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  closeList();
  return html.join('\n');
}

// ── read the session ───────────────────────────────────────────────────────────────────────────
const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const blocks = [];
const toolNameById = new Map();

// ── redaction ──────────────────────────────────────────────────────────────────────────────────
// The markdown transcript collapses tool calls to one line and never shows their output. This
// renderer DOES show output, which is the whole point of it looking like the terminal — and that
// reintroduces everything the markdown pass never had to worry about. The very first command in
// this session was a recon `ls` of the parent directory, so without this the page opens with a
// listing of every unrelated project on the machine, including a legal memo filename.
//
// Rule: any output line matching the denylist is dropped entirely rather than partially masked.
// A half-redacted line still leaks its shape.
const DENY = new RegExp(
  [
    'HighYield', 'abogada', 'Velzia', 'Beckham', 'trezor', 'adorni', 'crypto',
    'Tarjetas_Alan', 'HistorIA', 'TRUMP', 'baulera', 'afip', 'autopreso', 'mudanzas',
    'entradauno', 'prode', 'mundial-', 'imperios', 'detector-toques', 'babylock',
    'carousels', 'dictado', 'engranajes', 'historia-landing', 'drive-compress', 'ferpa',
    'central-crediticia', 'baby-tinder', 'ai-repeater', '3-body', 'hostinger', 'openclaw',
    'trello', 'whatsapp', 'pigna', 'geuna', 'newsletter', 'mailerlite', 'gmail',
    '/Users/', 'mortgage-csv', 'teleprompter', 'replies_log', 'rtdetr',
  ].join('|'),
  'i'
);


// One more class of leak, and a subtle one: my own prose. Reporting a privacy sweep by listing
// the terms searched for discloses exactly what the sweep was protecting. Same for anything that
// names an unrelated project. These are rewritten, not dropped, so the sentence still reads.
const PROSE = [
  [/Busqué explícitamente [^.]+\./g,
   'Busqué explícitamente una lista de términos sensibles: cuentas y billeteras, expedientes legales, infraestructura propia, credenciales y los nombres de sus otros proyectos.'],
  [/Trezor, direcciones de wallet[^.]*\./g, 'una lista de términos sensibles.'],
  [/ni Trezor, ni Hostinger, ni Trello, ni el índice de memoria/g,
   'ninguno de los términos sensibles, ni el índice de memoria'],
  [/Ahí se lee el memo de tu abogada, tus otros proyectos y rutas personales/g,
   'Ahí se leen documentos personales, otros proyectos y rutas del sistema'],
];
function redactProse(t) {
  let s = String(t);
  for (const [re, to] of PROSE) s = s.replace(re, to);
  return s;
}

function redact(text) {
  const out = [];
  let dropped = 0;
  for (const line of String(text).split('\n')) {
    if (DENY.test(line)) { dropped++; continue; }
    if (dropped) { out.push('⋯ [' + dropped + (dropped === 1 ? ' línea redactada' : ' líneas redactadas') + ']'); dropped = 0; }
    out.push(line);
  }
  if (dropped) out.push('⋯ [' + dropped + (dropped === 1 ? ' línea redactada' : ' líneas redactadas') + ']');
  return out.join('\n');
}

const oneLine = (s, n = 130) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The single most useful thing to show beside a tool name — what it actually did. */
function argSummary(name, input) {
  const i = input || {};
  if (name === 'Bash') return i.description || i.command;
  if (name === 'Read' || name === 'Write' || name === 'Edit') return (i.file_path || '').split('/').slice(-2).join('/');
  if (name === 'Workflow') return i.description || (i.scriptPath || '').split('/').pop() || 'workflow';
  if (name === 'Agent' || name === 'Task') return i.description;
  if (name === 'SendUserFile') return (i.files || []).map((f) => f.split('/').pop()).join(', ');
  if (name === 'ToolSearch') return i.query;
  return i.description || i.title || i.prompt || i.query || oneLine(JSON.stringify(i));
}

for (const raw of entries) {
  let e;
  try { e = JSON.parse(raw); } catch { continue; }
  const m = e.message;
  if (!m || !m.role) continue;
  const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];

  if (m.role === 'user') {
    for (const p of parts) {
      if (p.type === 'tool_result') {
        const c = p.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
            : '';
        blocks.push({ kind: 'result', text: redact(text), error: !!p.is_error, id: p.tool_use_id });
      }
    }
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .trim();
    const hasImage = parts.some((p) => p.type === 'image');
    if (text && !text.startsWith('[SYSTEM NOTIFICATION')) {
      blocks.push({ kind: 'user', text, hasImage });
    }
    continue;
  }

  if (m.role === 'assistant') {
    for (const p of parts) {
      if (p.type === 'text' && p.text?.trim()) blocks.push({ kind: 'assistant', text: redactProse(p.text.trim()) });
      else if (p.type === 'tool_use') {
        toolNameById.set(p.id, p.name);
        blocks.push({ kind: 'tool', name: p.name, arg: argSummary(p.name, p.input), id: p.id });
      }
    }
  }
}

// ── emit ───────────────────────────────────────────────────────────────────────────────────────
const parts = [];
let userTurns = 0;
let toolCalls = 0;

for (let n = 0; n < blocks.length; n++) {
  const b = blocks[n];

  if (b.kind === 'user') {
    userTurns++;
    parts.push(
      `<div class="turn user"><div class="caret">&gt;</div><div class="utext">${
        esc(b.text).replace(/\n/g, '<br>')
      }${b.hasImage ? '<div class="attach">📎 imagen adjunta — la fotografía del living</div>' : ''}</div></div>`
    );
    continue;
  }

  if (b.kind === 'assistant') {
    parts.push(`<div class="turn assistant">${markdown(b.text)}</div>`);
    continue;
  }

  if (b.kind === 'tool') {
    toolCalls++;
    // Pair the call with the result that follows it, the way the terminal renders them.
    const res = blocks.slice(n + 1, n + 4).find((x) => x.kind === 'result' && x.id === b.id);
    let resHtml = '';
    if (res) {
      const all = String(res.text).split('\n');
      const shown = all.slice(0, MAX_RESULT_LINES).join('\n');
      const rest = all.length - MAX_RESULT_LINES;
      resHtml =
        `<div class="res${res.error ? ' err' : ''}"><span class="gut">⎿</span><pre>${esc(shown)}</pre>` +
        (rest > 0 ? `<div class="more">… +${rest} líneas</div>` : '') +
        `</div>`;
    }
    parts.push(
      `<div class="tool"><div class="call"><span class="dot">⏺</span><span class="tname">${esc(b.name)}</span>` +
      `<span class="targ">(${esc(redact(oneLine(b.arg)) || '…')})</span></div>${resHtml}</div>`
    );
  }
}

const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPERACIÓN SIESTA — la sesión completa</title>
<style>
:root{
  --bg:#161513; --panel:#1c1b19; --line:#2b2926;
  --fg:#e6e2dc; --dim:#8e877d; --faint:#6a645c;
  --coral:#d97757; --green:#7fa87f; --blue:#7f9ec4; --red:#c96a5a;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:13.5px/1.65 var(--mono);
  -webkit-font-smoothing:antialiased;padding:0 0 8rem}
.wrap{max-width:1020px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line);padding:26px 0 18px;margin-bottom:26px}
h1.top{font-size:15px;font-weight:700;margin:0 0 6px;letter-spacing:.02em}
h1.top .accent{color:var(--coral)}
.sub{color:var(--dim);font-size:12px;margin:0}
.stats{display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;color:var(--faint);font-size:11.5px}
.stats b{color:var(--fg);font-weight:600}

.turn.user{display:flex;gap:10px;margin:30px 0 22px;padding:12px 14px;
  background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--coral);border-radius:4px}
.caret{color:var(--coral);font-weight:700;flex:none}
.utext{white-space:normal;color:#f0ece6}
.attach{margin-top:8px;color:var(--faint);font-size:11.5px}

.turn.assistant{margin:18px 0 22px}
.turn.assistant p{margin:0 0 12px;white-space:pre-wrap}
.turn.assistant h2{font-size:14.5px;margin:22px 0 10px;color:#fff}
.turn.assistant h3,.turn.assistant h4,.turn.assistant h5{font-size:13.5px;margin:18px 0 8px;color:#fff}
.turn.assistant ul,.turn.assistant ol{margin:0 0 12px;padding-left:20px}
.turn.assistant li{margin:3px 0}
strong{color:#fff;font-weight:700}
em{color:var(--dim);font-style:italic}
a{color:var(--blue);text-decoration:none;border-bottom:1px solid rgba(127,158,196,.35)}
a:hover{border-bottom-color:var(--blue)}
code{background:#252320;border:1px solid var(--line);border-radius:3px;padding:.5px 4px;color:#e9c9a8;font-size:12.5px}
pre.code{background:#121110;border:1px solid var(--line);border-radius:4px;
  padding:12px 14px;overflow-x:auto;margin:0 0 14px}
pre.code code{background:none;border:0;padding:0;color:#cfd4c9;font-size:12.5px}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
table{border-collapse:collapse;margin:0 0 14px;font-size:12.5px;width:100%;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}
th{background:#201f1c;color:#fff;font-weight:600}

.tool{margin:0 0 10px}
.call{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dot{color:var(--green);flex:none}
.tname{color:#fff;font-weight:600}
.targ{color:var(--dim);word-break:break-word}
.res{display:flex;gap:8px;margin:2px 0 0 8px;color:var(--faint)}
.res .gut{flex:none;color:var(--line)}
.res pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;max-width:100%}
.res.err pre{color:var(--red)}
.more{color:var(--line);font-size:11.5px;margin-top:2px}
footer{border-top:1px solid var(--line);margin-top:40px;padding-top:18px;color:var(--faint);font-size:11.5px}
@media (max-width:640px){body{font-size:12.5px}.wrap{padding:0 12px}}
</style></head><body><div class="wrap">
<header>
  <h1 class="top">✻ <span class="accent">OPERACIÓN SIESTA</span> — la sesión completa</h1>
  <p class="sub">De una fotografía de un living a un juego 3D deployado. Todo procedural: ni una textura, ni un modelo, ni un sonido importado.</p>
  <div class="stats">
    <span><b>${userTurns}</b> mensajes</span>
    <span><b>${toolCalls}</b> llamadas a herramientas</span>
    <span><b>71</b> subagentes</span>
    <span><b>47.219</b> líneas de código</span>
    <span><a href="https://operacion-siesta.vercel.app">jugar</a></span>
    <span><a href="https://github.com/alandaitch/operacion-siesta">código</a></span>
  </div>
</header>
${parts.join('\n')}
<footer>Generado desde el log de la sesión con <code>tools/transcript-html.mjs</code>. La prosa está textual salvo unas pocas referencias redactadas por privacidad; los resultados de herramientas están recortados a ${MAX_RESULT_LINES} líneas y filtrados.</footer>
</div></body></html>`;

fs.writeFileSync(out, html);
console.log(`${out} — ${userTurns} mensajes, ${toolCalls} llamadas, ${(html.length / 1024).toFixed(0)} KB`);
