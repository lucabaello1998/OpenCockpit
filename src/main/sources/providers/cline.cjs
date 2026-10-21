'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcripts = require('../transcripts.cjs');

// Cline y Roo Code (extensiones de VS Code) guardan una carpeta por tarea:
//   <globalStorage>/saoudrizwan.claude-dev/tasks/<id>/
//   <globalStorage>/rooveterinaryinc.roo-cline/tasks/<id>/
// con ui_messages.json, api_conversation_history.json y task_metadata.json.
// task_metadata trae tokens y costo; no siempre trae el modelo.
const BASES = [
  ['saoudrizwan.claude-dev', 'Cline'],
  ['rooveterinaryinc.roo-cline', 'Roo Code'],
];

function raices() {
  if (process.env.CLINE_HOME) return [{ dir: process.env.CLINE_HOME, label: 'Cline / Roo Code' }];
  const out = [];
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage'));
  roots.push(path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'));
  roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'));
  for (const root of roots) {
    for (const [carpeta, label] of BASES) {
      const dir = path.join(root, carpeta);
      if (fs.existsSync(path.join(dir, 'tasks'))) out.push({ dir, label });
    }
  }
  return out;
}

function disponible() {
  return raices().length > 0;
}

let cache = { firma: null, data: null };

function firmaDe(roots) {
  const partes = [];
  for (const r of roots) {
    const t = path.join(r.dir, 'tasks');
    let max = 0;
    let n = 0;
    try {
      for (const e of fs.readdirSync(t, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        n++;
        try { max = Math.max(max, fs.statSync(path.join(t, e.name)).mtimeMs); } catch { /* borrada */ }
      }
    } catch { /* sin tasks */ }
    partes.push(`${t}:${n}:${max}`);
  }
  return partes.join('|');
}

function leerJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function iso(v) {
  if (!v) return null;
  const n = Number(v);
  const d = new Date(Number.isFinite(n) && n < 1e12 ? n * 1000 : v);
  return isNaN(d) ? null : d.toISOString();
}

function textoDeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || ''))
    .filter(Boolean)
    .join('\n');
}

function leerTarea(dir) {
  const ui = leerJson(path.join(dir, 'ui_messages.json')) || [];
  const meta = leerJson(path.join(dir, 'task_metadata.json')) || {};
  const hist = leerJson(path.join(dir, 'api_conversation_history.json'));

  let mensajes = [];
  if (Array.isArray(hist) && hist.length) {
    mensajes = hist
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({
        role: m.role,
        ts: iso(m.ts || m.timestamp),
        text: transcripts.cleanPrompt(textoDeContent(m.content)),
      }))
      .filter((m) => m.text.trim());
  }

  if (!mensajes.length && Array.isArray(ui)) {
    mensajes = ui
      .filter((m) => m && m.text && (m.say === 'text' || m.say === 'task' || m.ask === 'followup'))
      .map((m) => ({
        role: m.say === 'text' ? 'assistant' : 'user',
        ts: iso(m.ts),
        text: transcripts.cleanPrompt(String(m.text)),
      }))
      .filter((m) => m.text.trim());
  }

  if (!mensajes.length) return null;

  const primero = mensajes.find((m) => m.role === 'user');
  const titulo = (meta.task && String(meta.task).trim()) || (primero && primero.text.slice(0, 160)) || '(sin título)';
  const ts = mensajes.map((m) => m.ts).filter(Boolean).sort();
  const tsUi = Array.isArray(ui) ? ui.map((m) => iso(m.ts)).filter(Boolean).sort() : [];
  let mtime = null;
  try { mtime = fs.statSync(dir).mtime.toISOString(); } catch { /* carpeta borrada */ }
  const tokensIn = Number(meta.tokensIn) || 0;
  const tokensOut = Number(meta.tokensOut) || 0;
  const cacheRead = Number(meta.cacheReads) || 0;
  const cacheWrite = Number(meta.cacheWrites) || 0;
  const costo = Number(meta.totalCost) || 0;

  return {
    mensajes,
    fila: {
      sessionId: path.basename(dir),
      provider: 'cline',
      providerLabel: 'Cline / Roo Code',
      file: null,
      projectDir: null,
      cwd: meta.cwd || null,
      gitBranch: null,
      version: null,
      title: titulo.slice(0, 160),
      firstPrompt: primero ? primero.text.slice(0, 400) : null,
      startedAt: ts[0] || tsUi[0] || mtime,
      endedAt: ts[ts.length - 1] || tsUi[tsUi.length - 1] || mtime,
      userTurns: mensajes.filter((m) => m.role === 'user').length,
      userTurnTimes: mensajes.filter((m) => m.role === 'user').map((m) => m.ts).filter(Boolean),
      toolCounts: {},
      models: {},
      agents: { count: 0, subagents: 0, workflowAgents: 0, workflows: [] },
      sizeBytes: 0,
      hasThread: true,
      hasUsage: tokensIn + tokensOut + cacheRead > 0,
      costKnown: Number.isFinite(costo),
    },
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    costo,
    model: meta.modelId || 'cline',
  };
}

function leer() {
  const roots = raices();
  const firma = firmaDe(roots);
  if (cache.data && cache.firma === firma) return cache.data;

  const sessions = [];
  const requests = [];

  for (const r of roots) {
    const base = path.join(r.dir, 'tasks');
    let tareas = [];
    try { tareas = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const t of tareas) {
      const dir = path.join(base, t.name);
      let hecha = null;
      try { hecha = leerTarea(dir); } catch { hecha = null; }
      if (!hecha) continue;
      const fila = hecha.fila;
      fila.providerLabel = r.label;
      if (hecha.tokensIn + hecha.tokensOut + hecha.cacheRead > 0) {
        requests.push({
          sessionId: fila.sessionId,
          from: 'session',
          provider: 'cline',
          ts: fila.endedAt || fila.startedAt,
          model: hecha.model,
          effort: null,
          input: hecha.tokensIn,
          output: hecha.tokensOut,
          thinking: 0,
          cacheRead: hecha.cacheRead,
          cacheWriteTotal: hecha.cacheWrite,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          webSearches: 0,
          webFetches: 0,
          costUSD: hecha.costo,
          costNoCacheUSD: hecha.costo,
        });
        fila.models = {
          [hecha.model]: {
            requests: 1,
            tokens: hecha.tokensIn + hecha.tokensOut + hecha.cacheRead,
            costUSD: hecha.costo,
          },
        };
      }
      sessions.push(fila);
    }
  }

  const data = { sessions, requests };
  cache = { firma, data };
  return data;
}

async function hilo(sessionId) {
  for (const r of raices()) {
    const dir = path.join(r.dir, 'tasks', sessionId);
    if (!fs.existsSync(dir)) continue;
    const hecha = leerTarea(dir);
    if (!hecha) return null;
    return hecha.mensajes.map((m, i) => ({
      i,
      role: m.role,
      ts: m.ts,
      uuid: null,
      requestId: null,
      model: null,
      isSidechain: false,
      isToolReturn: false,
      injected: false,
      injectedKind: null,
      isConversation: true,
      blocks: [{ type: 'text', text: m.text }],
      usage: null,
    }));
  }
  return null;
}

module.exports = { id: 'cline', label: 'Cline / Roo Code', disponible, leer, hilo };
