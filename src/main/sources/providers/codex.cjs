'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const transcripts = require('../transcripts.cjs');

// Codex CLI:
//   ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl  -> una sesion por archivo
//   ~/.codex/state_5.sqlite (tabla threads)       -> titulo, cwd y tokens
// El rollout trae el detalle (mensajes y token_count acumulado); la base trae
// el nombre corto y el cwd ya resueltos.
const DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS = path.join(DIR, 'sessions');
const STATE_DB = path.join(DIR, 'state_5.sqlite');

let cache = { firma: null, data: null };

function disponible() {
  return fs.existsSync(SESSIONS);
}

function archivosRollout() {
  const out = [];
  const walk = (dir) => {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(SESSIONS);
  return out;
}

function firmaActual(archivos) {
  let max = 0;
  let total = 0;
  for (const f of archivos) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > max) max = st.mtimeMs;
      total += st.size;
    } catch { /* archivo borrado mientras se recorre */ }
  }
  let state = 0;
  try { state = fs.statSync(STATE_DB).mtimeMs; } catch { /* sin base */ }
  return `${archivos.length}:${max}:${total}:${state}`;
}

function iso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function cwdLimpio(cwd) {
  return String(cwd || '').replace(/^\\\\\?\\/, '') || null;
}

function normalizarRuta(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function uuidDeArchivo(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

function leerThreads() {
  const map = new Map();
  if (!fs.existsSync(STATE_DB)) return map;
  let db;
  try {
    db = new DatabaseSync(STATE_DB, { readOnly: true, timeout: 2000 });
    const filas = db.prepare(`
      select id, rollout_path, created_at, updated_at, cwd, title, name,
             tokens_used, model, first_user_message, git_branch, cli_version
      from threads
    `).all();
    for (const f of filas) map.set(f.id, f);
  } catch {
    // La base es un cache: si no se puede leer, el rollout alcanza.
  } finally {
    if (db) db.close();
  }
  return map;
}

function leerRollout(file) {
  const salida = {
    cwd: null,
    cliVersion: null,
    model: null,
    startedAt: null,
    endedAt: null,
    primerPrompt: null,
    userTurns: 0,
    userTurnTimes: [],
    toolCounts: {},
    requests: [],
    mensajes: [],
  };

  let crudo;
  try { crudo = fs.readFileSync(file, 'utf8'); } catch { return salida; }
  let anterior = null;

  for (const linea of crudo.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    let row;
    try { row = JSON.parse(linea); } catch { continue; }
    const ts = row.timestamp || null;
    if (ts) {
      if (!salida.startedAt || ts < salida.startedAt) salida.startedAt = ts;
      if (!salida.endedAt || ts > salida.endedAt) salida.endedAt = ts;
    }

    const p = row.payload || {};

    if (row.type === 'session_meta') {
      salida.cwd = cwdLimpio(p.cwd) || salida.cwd;
      salida.cliVersion = p.cli_version || null;
      continue;
    }

    if (row.type === 'turn_context') {
      salida.cwd = cwdLimpio(p.cwd) || salida.cwd;
      salida.model = p.model || salida.model;
      continue;
    }

    if (row.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const t = p.info.total_token_usage || {};
      const actual = {
        input: Number(t.input_tokens) || 0,
        cached: Number(t.cached_input_tokens) || 0,
        output: Number(t.output_tokens) || 0,
        reasoning: Number(t.reasoning_output_tokens) || 0,
      };
      const prev = anterior || { input: 0, cached: 0, output: 0, reasoning: 0 };
      const d = {
        input: Math.max(0, actual.input - prev.input),
        cached: Math.max(0, actual.cached - prev.cached),
        output: Math.max(0, actual.output - prev.output),
        reasoning: Math.max(0, actual.reasoning - prev.reasoning),
      };
      anterior = actual;
      if (!d.input && !d.cached && !d.output && !d.reasoning) continue;

      salida.requests.push({
        ts,
        model: salida.model || 'codex',
        // input_tokens incluye los cacheados: se separan para que el grafico
        // de tokens se compare con el lado Claude.
        input: Math.max(0, d.input - d.cached),
        output: d.output,
        thinking: d.reasoning,
        cacheRead: d.cached,
        cacheWrite: 0,
      });
      continue;
    }

    if (row.type === 'response_item') {
      const esMensaje = p.type === 'message' && (p.role === 'user' || p.role === 'assistant');
      if (esMensaje) {
        const texto = (Array.isArray(p.content) ? p.content : [])
          .filter((c) => c && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text'))
          .map((c) => c.text || '')
          .join('\n');
        const limpio = p.role === 'user' ? transcripts.cleanPrompt(texto) : texto;
        if (p.role === 'user') {
          if (limpio.trim()) {
            salida.userTurns++;
            if (ts) salida.userTurnTimes.push(ts);
          }
          if (!salida.primerPrompt && limpio.trim()) {
            salida.primerPrompt = limpio.slice(0, 400);
          }
        }
        if (limpio.trim()) {
          salida.mensajes.push({
            role: p.role,
            ts,
            model: salida.model,
            blocks: [{ type: 'text', text: limpio }],
          });
        }
      } else if (p.type === 'reasoning') {
        const texto = [
          ...(Array.isArray(p.summary) ? p.summary : []),
          ...(Array.isArray(p.content) ? p.content : []),
        ].map((c) => (c && (c.text || c.summary_text)) || '').join('\n');
        if (texto.trim()) {
          salida.mensajes.push({ role: 'assistant', ts, blocks: [{ type: 'thinking', text: texto }] });
        }
      } else if (p.type === 'function_call') {
        salida.toolCounts[p.name || 'tool'] = (salida.toolCounts[p.name || 'tool'] || 0) + 1;
        salida.mensajes.push({
          role: 'assistant',
          ts,
          blocks: [{
            type: 'tool_use',
            name: p.name || 'tool',
            id: p.call_id || null,
            text: String(p.arguments || ''),
          }],
        });
      } else if (p.type === 'function_call_output') {
        salida.mensajes.push({
          role: 'user',
          ts,
          isToolReturn: true,
          blocks: [{ type: 'tool_result', id: p.call_id || null, text: String(p.output || '') }],
        });
      }
    }
  }

  return salida;
}

function leer() {
  const archivos = archivosRollout();
  const firma = firmaActual(archivos);
  if (cache.data && cache.firma === firma) return cache.data;

  const threads = leerThreads();
  const idPorRollout = new Map();
  for (const t of threads.values()) {
    if (t.rollout_path) idPorRollout.set(normalizarRuta(t.rollout_path), t.id);
  }
  const sessions = [];
  const requests = [];

  for (const file of archivos) {
    const idArchivo = idPorRollout.get(normalizarRuta(file)) || uuidDeArchivo(file) || path.basename(file);
    const meta = threads.get(idArchivo) || null;
    const r = leerRollout(file);

    const modeloTotales = {};
    for (const req of r.requests) {
      requests.push({
        sessionId: idArchivo,
        from: 'session',
        provider: 'codex',
        ts: req.ts,
        model: req.model,
        effort: null,
        input: req.input,
        output: req.output,
        thinking: req.thinking,
        cacheRead: req.cacheRead,
        cacheWriteTotal: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        webSearches: 0,
        webFetches: 0,
        costUSD: 0,
        costNoCacheUSD: 0,
      });
      const k = req.model || 'codex';
      if (!modeloTotales[k]) modeloTotales[k] = { requests: 0, tokens: 0, costUSD: 0 };
      modeloTotales[k].requests++;
      modeloTotales[k].tokens += req.input + req.output + req.cacheRead;
    }

    const cwd = (meta && cwdLimpio(meta.cwd)) || r.cwd;
    const primerPrompt = (meta && meta.first_user_message && transcripts.cleanPrompt(meta.first_user_message)) ||
      r.primerPrompt || null;
    const titulo = (meta && (meta.name || meta.title)) || primerPrompt || '(sin título)';

    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(file).size; } catch { /* borrado */ }

    sessions.push({
      sessionId: idArchivo,
      provider: 'codex',
      providerLabel: 'Codex',
      file: null,
      projectDir: null,
      cwd,
      gitBranch: (meta && meta.git_branch) || null,
      version: (meta && meta.cli_version) || r.cliVersion || null,
      title: String(titulo).slice(0, 160),
      firstPrompt: r.primerPrompt || (meta && meta.first_user_message) || null,
      startedAt: r.startedAt || iso(meta && meta.created_at),
      endedAt: r.endedAt || iso(meta && meta.updated_at),
      userTurns: r.userTurns,
      userTurnTimes: r.userTurnTimes,
      toolCounts: r.toolCounts,
      models: modeloTotales,
      agents: { count: 0, subagents: 0, workflowAgents: 0, workflows: [] },
      sizeBytes,
      hasThread: true,
      hasUsage: r.requests.length > 0,
      costKnown: false,
    });
  }

  const data = { sessions, requests };
  cache = { firma, data };
  return data;
}

async function hilo(sessionId) {
  const archivos = archivosRollout();
  const file = archivos.find((f) => f.includes(sessionId));
  if (!file) return null;
  const r = leerRollout(file);
  return r.mensajes.map((m, i) => ({
    i,
    role: m.role,
    ts: m.ts,
    uuid: null,
    requestId: null,
    model: m.model || null,
    isSidechain: false,
    isToolReturn: !!m.isToolReturn,
    injected: false,
    injectedKind: null,
    isConversation: m.blocks.some((b) => b.type === 'text'),
    blocks: m.blocks,
    usage: null,
  }));
}

module.exports = { id: 'codex', label: 'Codex', disponible, leer, hilo };
