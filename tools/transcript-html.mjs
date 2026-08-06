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
    const empty = res && !String(res.text).replace(/⋯ \[[^\]]*\]/g, '').trim();
    let resHtml = '';
    if (res && !empty) {
      const all = String(res.text).split('\n');
      const shown = all.slice(0, MAX_RESULT_LINES).join('\n');
      const rest = all.length - MAX_RESULT_LINES;
      resHtml =
        `<div class="res${res.error ? ' err' : ''}"><span class="gut">⎿</span><div class="rbody">` +
        `<pre>${esc(shown)}</pre>` +
        (rest > 0 ? `<div class="more">… +${rest} líneas</div>` : '') +
        `</div></div>`;
    }
    parts.push(
      `<div class="tool"><div class="call"><span class="dot">⏺</span><span class="tname">${esc(b.name)}</span>` +
      `<span class="targ">(${esc(redact(oneLine(b.arg)) || '…')})</span></div>${resHtml}</div>`
    );
  }
}

const html = `<!doctype html>
<html lang="es" data-skin="app"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPERACIÓN SIESTA — la sesión completa</title>
<style>
/* Two skins on one document. "app" is the default and mirrors the Claude desktop app: warm
   paper, a reading typeface, rounded cards, coral only where it means something. "term" is the
   same content dressed as the terminal. The toggle writes data-skin on <html>. */
:root{
  --coral:#d97757; --radius:12px;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
[data-skin=app]{
  --bg:#faf9f7; --panel:#f0eee9; --card:#fff; --line:#e5e1da; --soft:#efece6;
  --fg:#1f1e1d; --dim:#6b6862; --faint:#8f8b83;
  --font:var(--sans); --size:16px; --lh:1.7; --width:46rem;
}
@media (prefers-color-scheme:dark){[data-skin=app]{
  --bg:#1f1e1d; --panel:#262523; --card:#242322; --line:#37352f; --soft:#2b2a27;
  --fg:#eeece7; --dim:#a8a29a; --faint:#7d786f;
}}
[data-skin=term]{
  --bg:#161513; --panel:#1c1b19; --card:#1c1b19; --line:#2b2926; --soft:#201f1c;
  --fg:#e6e2dc; --dim:#8e877d; --faint:#6a645c;
  --font:var(--mono); --size:13.5px; --lh:1.65; --width:62rem;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:var(--size)/var(--lh) var(--font);
  -webkit-font-smoothing:antialiased;padding:0 0 7rem}
.wrap{max-width:var(--width);margin:0 auto;padding:0 22px}

header{padding:30px 0 20px;margin-bottom:8px;border-bottom:1px solid var(--line)}
h1.top{font-size:1.15em;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}
[data-skin=term] h1.top{font-weight:700;letter-spacing:.02em}
h1.top .accent{color:var(--coral)}
.sub{color:var(--dim);font-size:.85em;margin:0;max-width:40rem}
.bar{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-top:14px;
  color:var(--faint);font-size:.76em}
.bar b{color:var(--fg);font-weight:600}
.skin{margin-left:auto;display:flex;gap:0;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.skin button{font:inherit;font-size:.95em;color:var(--dim);background:none;border:0;
  padding:5px 13px;cursor:pointer}
.skin button[aria-pressed=true]{background:var(--coral);color:#fff}

.turn.user{margin:34px 0 20px;padding:14px 18px;background:var(--panel);
  border:1px solid var(--line);border-radius:var(--radius)}
[data-skin=term] .turn.user{border-radius:4px;border-left:2px solid var(--coral);
  display:flex;gap:10px;padding:12px 14px}
.caret{color:var(--coral);font-weight:700;flex:none;display:none}
[data-skin=term] .caret{display:block}
.utext{color:var(--fg)}
[data-skin=app] .utext{font-size:1.02em}
.attach{margin-top:9px;color:var(--faint);font-size:.8em}

.turn.assistant{margin:16px 0 26px}
.turn.assistant p{margin:0 0 14px;white-space:pre-wrap}
.turn.assistant h2{font-size:1.16em;margin:26px 0 10px;font-weight:650;letter-spacing:-.01em}
.turn.assistant h3,.turn.assistant h4,.turn.assistant h5{font-size:1.02em;margin:20px 0 8px;font-weight:650}
.turn.assistant ul,.turn.assistant ol{margin:0 0 14px;padding-left:22px}
.turn.assistant li{margin:5px 0}
strong{font-weight:650;color:var(--fg)}
[data-skin=term] strong{color:#fff;font-weight:700}
em{color:var(--dim);font-style:italic}
a{color:var(--coral);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--coral) 35%,transparent)}
a:hover{border-bottom-color:var(--coral)}
code{font-family:var(--mono);font-size:.87em;background:var(--soft);
  border:1px solid var(--line);border-radius:5px;padding:1px 5px}
pre.code{font-family:var(--mono);background:var(--soft);border:1px solid var(--line);
  border-radius:var(--radius);padding:13px 15px;overflow-x:auto;margin:0 0 16px;font-size:.85em;line-height:1.55}
[data-skin=term] pre.code{border-radius:4px}
pre.code code{background:none;border:0;padding:0;font-size:1em}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
table{border-collapse:collapse;margin:0 0 16px;font-size:.88em;width:100%;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:7px 11px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600}

.tool{margin:0 0 8px;font-family:var(--mono);font-size:.83em}
[data-skin=app] .tool{background:var(--card);border:1px solid var(--line);
  border-radius:10px;padding:9px 13px}
.call{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dot{color:var(--coral);flex:none;font-size:.85em}
[data-skin=term] .dot{color:#7fa87f}
.tname{font-weight:650}
.targ{color:var(--dim);word-break:break-word}
.res{display:flex;gap:8px;margin:6px 0 0;color:var(--faint)}
[data-skin=app] .res{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.res .gut{flex:none;color:var(--line)}
[data-skin=app] .res .gut{display:none}
.rbody{min-width:0;flex:1}
.res pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:.95em;max-width:100%;font-family:var(--mono)}
.res.err pre{color:#c96a5a}
.more{color:var(--faint);opacity:.7;font-size:.9em;margin-top:3px}
footer{border-top:1px solid var(--line);margin-top:44px;padding-top:20px;color:var(--faint);font-size:.8em}
@media (max-width:640px){.wrap{padding:0 14px}[data-skin=app]{--size:15px}}
</style></head><body><div class="wrap">
<header>
  <h1 class="top">✻ <span class="accent">OPERACIÓN SIESTA</span> — la sesión completa</h1>
  <p class="sub">De una fotografía de un living a un juego 3D deployado. Todo procedural: ni una textura, ni un modelo, ni un sonido importado.</p>
  <div class="bar">
    <span><b>${userTurns}</b> mensajes</span>
    <span><b>${toolCalls}</b> herramientas</span>
    <span><b>71</b> subagentes</span>
    <span><b>47.219</b> líneas</span>
    <span><a href="https://operacion-siesta.vercel.app">jugar</a></span>
    <span><a href="https://github.com/alandaitch/operacion-siesta">código</a></span>
    <span class="skin">
      <button data-s="app" aria-pressed="true">App</button><button data-s="term" aria-pressed="false">Terminal</button>
    </span>
  </div>
</header>
${parts.join('\n')}
<footer>Generado desde el log de la sesión con <code>tools/transcript-html.mjs</code>. La prosa está textual salvo unas pocas referencias redactadas por privacidad; los resultados de herramientas están recortados a ${MAX_RESULT_LINES} líneas y filtrados.</footer>
</div>
<script>
(() => {
  const root = document.documentElement;
  const set = (s) => {
    root.dataset.skin = s;
    for (const b of document.querySelectorAll('.skin button'))
      b.setAttribute('aria-pressed', String(b.dataset.s === s));
    try { localStorage.setItem('siesta.skin', s); } catch {}
  };
  try { const v = localStorage.getItem('siesta.skin'); if (v) set(v); } catch {}
  for (const b of document.querySelectorAll('.skin button'))
    b.addEventListener('click', () => set(b.dataset.s));
})();
</script>
</body></html>`;

fs.writeFileSync(out, html);
console.log(`${out} — ${userTurns} mensajes, ${toolCalls} llamadas, ${(html.length / 1024).toFixed(0)} KB`);
