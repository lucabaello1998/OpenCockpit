'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Cursor guarda el historial del chat en su base de VS Code:
//   %APPDATA%/Cursor/User/globalStorage/state.vscdb
// Las conversaciones nuevas estan en la tabla cursorDiskKV con claves
// `composerData:<id>` y los mensajes en `bubbleId:<composerId>:<bubbleId>`.
// Las viejas, en ItemTable -> workbench.panel.aichat.view.aichat.chatdata.
// No siempre hay tokens: si no estan, la sesion se lista igual (sin uso).
const REL = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];

function candidatos() {
  if (process.env.CURSOR_HOME) return [path.join(process.env.CURSOR_HOME, 'User', 'globalStorage', 'state.vscdb')];
  const out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, ...REL));
  out.push(path.join(os.homedir(), '.config', ...REL));
  out.push(path.join(os.homedir(), 'Library', 'Application Support', ...REL));
  return out;
}

function archivo() {
  return candidatos().find((f) => fs.existsSync(f)) || null;
}

function disponible() {
  return !!archivo();
}

let cache = { firma: null, data: null };

function firmaActual(f) {
  try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

function texto(v) {
  if (v == null) return '';
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

function json(v, fallback) {
  try { return JSON.parse(texto(v)); } catch { return fallback; }
}

function iso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function textoBurbuja(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (typeof b.richText === 'string') return b.richText;
  if (Array.isArray(b.content)) {
    return b.content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n');
  }
  return '';
}

function rolDe(b) {
  const t = Number(b && b.type);
  if (t === 1) return 'user';
  if (t === 2) return 'assistant';
  return b && b.role === 'user' ? 'user' : 'assistant';
}

function mensajesDe(burbujas) {
  const out = [];
  let i = 0;
  for (const b of burbujas) {
    const t = textoBurbuja(b).trim();
    if (!t) continue;
    out.push({
      i: i++,
      role: rolDe(b),
      ts: iso(b.createdAt || b.timestamp || (b.timingInfo && b.timingInfo.createdAt)),
      uuid: b.bubbleId || null,
      requestId: null,
      model: (b.modelInfo && b.modelInfo.modelName) || null,
      isSidechain: false,
      isToolReturn: false,
      injected: false,
      injectedKind: null,
      isConversation: true,
      blocks: [{ type: 'text', text: t }],
      usage: null,
    });
  }
  return out;
}

function leerComposers(db) {
  const filas = [];
  try {
    const rows = db.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all();
    for (const r of rows) {
      const data = json(r.value, null);
      if (!data) continue;
      const id = data.composerId || String(r.key).slice('composerData:'.length);
      let burbujas = Array.isArray(data.conversation) ? data.conversation : [];
      if (!burbujas.length && Array.isArray(data.tabs)) {
        burbujas = data.tabs.flatMap((t) => (Array.isArray(t.bubbles) ? t.bubbles : []));
      }

      let tokensIn = 0;
      let tokensOut = 0;
      try {
        for (const b of db.prepare('select value from cursorDiskKV where key like ?').all(`bubbleId:${id}:%`)) {
          const bb = json(b.value, null);
          const tc = (bb && (bb.tokenCount || bb.usage)) || {};
          tokensIn += Number(tc.inputTokens || tc.promptTokens) || 0;
          tokensOut += Number(tc.outputTokens || tc.completionTokens) || 0;
        }
      } catch { /* sin tokens por burbuja */ }

      filas.push({ id, data, burbujas, tokensIn, tokensOut });
    }
  } catch { /* version vieja sin cursorDiskKV */ }
  return filas;
}

function leerChatdata(db) {
  try {
    const row = db.prepare('select value from ItemTable where key = ?')
      .get('workbench.panel.aichat.view.aichat.chatdata');
    if (!row) return [];
    const data = json(row.value, null);
    if (!data || !Array.isArray(data.tabs)) return [];
    return data.tabs.map((t, n) => ({
      id: t.tabId || t.id || `tab-${n}`,
      data: { name: t.chatTitle || t.title, createdAt: t.lastSendTime, lastUpdatedAt: t.lastSendTime },
      burbujas: Array.isArray(t.bubbles) ? t.bubbles : [],
      tokensIn: 0,
      tokensOut: 0,
    }));
  } catch {
    return [];
  }
}

function leer() {
  const f = archivo();
  if (!f) return { sessions: [], requests: [] };
  const firma = firmaActual(f);
  if (cache.data && cache.firma === firma) return cache.data;

  const db = new DatabaseSync(f, { readOnly: true, timeout: 2000 });
  try {
    let composers = leerComposers(db);
    if (!composers.length) composers = leerChatdata(db);

    const sessions = [];
    const requests = [];
    for (const c of composers) {
      const mensajes = mensajesDe(c.burbujas);
      if (!mensajes.length) continue;
      const primerUser = mensajes.find((m) => m.role === 'user');
      const primerPrompt = primerUser ? primerUser.blocks[0].text.slice(0, 400) : null;
      const titulo = (c.data && (c.data.name || c.data.title)) || primerPrompt || '(sin título)';
      const ts = mensajes.map((m) => m.ts).filter(Boolean).sort();
      const tieneTokens = c.tokensIn + c.tokensOut > 0;

      if (tieneTokens) {
        requests.push({
          sessionId: c.id,
          from: 'session',
          provider: 'cursor',
          ts: ts[0] || null,
          model: 'cursor',
          effort: null,
          input: c.tokensIn,
          output: c.tokensOut,
          thinking: 0,
          cacheRead: 0,
          cacheWriteTotal: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          webSearches: 0,
          webFetches: 0,
          costUSD: 0,
          costNoCacheUSD: 0,
        });
      }

      sessions.push({
        sessionId: c.id,
        provider: 'cursor',
        providerLabel: 'Cursor',
        file: null,
        projectDir: null,
        cwd: null,
        gitBranch: null,
        version: null,
        title: String(titulo).slice(0, 160),
        firstPrompt: primerPrompt,
        startedAt: iso(c.data && c.data.createdAt) || ts[0] || null,
        endedAt: iso(c.data && c.data.lastUpdatedAt) || ts[ts.length - 1] || null,
        userTurns: mensajes.filter((m) => m.role === 'user').length,
        userTurnTimes: mensajes.filter((m) => m.role === 'user').map((m) => m.ts).filter(Boolean),
        toolCounts: {},
        models: tieneTokens ? { cursor: { requests: 1, tokens: c.tokensIn + c.tokensOut, costUSD: 0 } } : {},
        agents: { count: 0, subagents: 0, workflowAgents: 0, workflows: [] },
        sizeBytes: 0,
        hasThread: true,
        hasUsage: tieneTokens,
        costKnown: false,
      });
    }

    const data = { sessions, requests };
    cache = { firma, data };
    return data;
  } finally {
    db.close();
  }
}

async function hilo(sessionId) {
  const f = archivo();
  if (!f) return null;
  const db = new DatabaseSync(f, { readOnly: true, timeout: 2000 });
  try {
    const row = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${sessionId}`);
    const data = row && json(row.value, null);
    if (data) {
      let burbujas = Array.isArray(data.conversation) ? data.conversation : [];
      if (!burbujas.length && Array.isArray(data.tabs)) {
        burbujas = data.tabs.flatMap((t) => (Array.isArray(t.bubbles) ? t.bubbles : []));
      }
      return mensajesDe(burbujas);
    }
    const viejo = leerChatdata(db).find((c) => c.id === sessionId);
    return viejo ? mensajesDe(viejo.burbujas) : null;
  } finally {
    db.close();
  }
}

module.exports = { id: 'cursor', label: 'Cursor', disponible, leer, hilo };
