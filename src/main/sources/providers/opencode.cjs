'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const transcripts = require('../transcripts.cjs');

// OpenCode guarda TODO en una SQLite (~60 MB en uso normal):
//   ~/.local/share/opencode/opencode.db
//   session_v2       -> una fila por sesion, con los totales AUTORITATIVOS
//   session_message  -> mensajes; el contenido y el usage viven en data (JSON)
//   project          -> worktree real
// El WAL se lee en modo read-only sin copiar nada.
const DIR = process.env.OPENCODE_DATA_DIR ||
  path.join(os.homedir(), '.local', 'share', 'opencode');
const DB = path.join(DIR, 'opencode.db');

let cache = { firma: null, data: null };

function disponible() {
  return fs.existsSync(DB);
}

function firmaActual() {
  const st = (f) => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
  };
  return `${st(DB)}|${st(DB + '-wal')}`;
}

function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function parseJson(txt, fallback) {
  try { return JSON.parse(txt); } catch { return fallback; }
}

function textoDeData(data) {
  if (!data) return '';
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.content)) {
    return data.content
      .filter((c) => c && (c.type === 'text' || c.type === 'reasoning'))
      .map((c) => c.text || '')
      .join('\n');
  }
  return '';
}

// Una fila por sesion raiz. Las sesiones hijas (subagentes) no se listan
// aparte: sus requests y tokens se suman a la raiz, igual que hace el lado
// Claude con los transcripts de subagentes.
function leer() {
  const firma = firmaActual();
  if (cache.data && cache.firma === firma) return cache.data;

  const db = new DatabaseSync(DB, { readOnly: true, timeout: 2000 });
  try {
    const proyectos = new Map(
      db.prepare('select id, worktree from project').all().map((p) => [p.id, p.worktree])
    );
    const sesiones = db.prepare(`
      select id, project_id, parent_id, slug, directory, title, version, agent, model,
             cost, tokens_input, tokens_output, tokens_reasoning,
             tokens_cache_read, tokens_cache_write,
             time_created, time_updated
      from session_v2
    `).all();
    const porId = new Map(sesiones.map((s) => [s.id, s]));

    const raizDe = (s) => {
      let actual = s;
      const visto = new Set();
      while (actual && actual.parent_id && porId.has(actual.parent_id) && !visto.has(actual.id)) {
        visto.add(actual.id);
        actual = porId.get(actual.parent_id);
      }
      return actual;
    };

    const mensajes = db.prepare(`
      select session_id, type, time_created, data
      from session_message
      where type in ('assistant', 'user')
      order by session_id, seq
    `).all();

    const porSesion = new Map();
    for (const m of mensajes) {
      if (!porSesion.has(m.session_id)) porSesion.set(m.session_id, []);
      porSesion.get(m.session_id).push(m);
    }

    const roots = sesiones.filter((s) => !s.parent_id || !porId.has(s.parent_id));
    const filas = [];
    const requests = [];

    for (const root of roots) {
      const miembros = sesiones.filter((s) => raizDe(s) === root);
      const modelo = parseJson(root.model, {}) || {};
      const cwd = root.directory || proyectos.get(root.project_id) || null;
      let firstPrompt = null;
      let startedAt = iso(root.time_created);
      let endedAt = iso(root.time_updated);
      let userTurns = 0;
      const userTurnTimes = [];
      const toolCounts = {};
      const models = {};

      for (const s of miembros) {
        const esHijo = s !== root;
        for (const m of porSesion.get(s.id) || []) {
          const data = parseJson(m.data, {}) || {};
          const ts = iso((data.time && data.time.created) || m.time_created);
          if (ts) {
            if (!startedAt || ts < startedAt) startedAt = ts;
            if (!endedAt || ts > endedAt) endedAt = ts;
          }

          if (m.type === 'user') {
            if (!esHijo) {
              userTurns++;
              if (ts) userTurnTimes.push(ts);
              if (!firstPrompt) {
                const limpio = transcripts.cleanPrompt(textoDeData(data));
                if (limpio) firstPrompt = limpio.slice(0, 400);
              }
            }
            continue;
          }

          const tokens = (data.tokens) || {};
          const cacheTokens = tokens.cache || {};
          const input = Number(tokens.input) || 0;
          const output = Number(tokens.output) || 0;
          const thinking = Number(tokens.reasoning) || 0;
          const cacheRead = Number(cacheTokens.read) || 0;
          const cacheWrite = Number(cacheTokens.write) || 0;
          const modelId = (data.model && data.model.id) || modelo.id || 'opencode';
          const costo = Number(data.cost) || 0;

          const bloques = Array.isArray(data.content) ? data.content : [];
          for (const b of bloques) {
            if (b && b.type === 'tool' && b.name) {
              toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
            }
          }

          if (input || output || cacheRead || cacheWrite) {
            requests.push({
              sessionId: root.id,
              from: esHijo ? 'subagent' : 'session',
              provider: 'opencode',
              ts,
              model: modelId,
              effort: (data.model && data.model.variant) || null,
              input,
              output,
              thinking,
              cacheRead,
              cacheWriteTotal: cacheWrite,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              webSearches: 0,
              webFetches: 0,
              costUSD: costo,
              costNoCacheUSD: costo,
            });

            if (!models[modelId]) models[modelId] = { requests: 0, tokens: 0, costUSD: 0 };
            models[modelId].requests++;
            models[modelId].tokens += input + output + cacheRead + cacheWrite;
            models[modelId].costUSD += costo;
          }
        }
      }

      filas.push({
        sessionId: root.id,
        provider: 'opencode',
        providerLabel: 'OpenCode',
        file: null,
        projectDir: null,
        cwd,
        gitBranch: null,
        version: root.version || null,
        title: root.title || root.slug || (firstPrompt ? firstPrompt.slice(0, 80) : '(sin título)'),
        firstPrompt,
        startedAt,
        endedAt,
        userTurns,
        userTurnTimes,
        toolCounts,
        models,
        agents: {
          count: Math.max(0, miembros.length - 1),
          subagents: Math.max(0, miembros.length - 1),
          workflowAgents: 0,
          workflows: [],
        },
        sizeBytes: 0,
        hasThread: true,
        hasUsage: true,
        costKnown: true,
      });
    }

    const data = { sessions: filas, requests };
    cache = { firma, data };
    return data;
  } finally {
    db.close();
  }
}

// --- hilo completo ---------------------------------------------------------

function bloquesDeMensaje(data) {
  const bloques = [];
  if (typeof data.text === 'string' && data.text.trim()) {
    bloques.push({ type: 'text', text: data.text });
  }
  for (const c of Array.isArray(data.content) ? data.content : []) {
    if (!c) continue;
    if (c.type === 'text' && String(c.text || '').trim()) {
      bloques.push({ type: 'text', text: c.text });
    } else if (c.type === 'reasoning' && String(c.text || '').trim()) {
      bloques.push({ type: 'thinking', text: c.text });
    } else if (c.type === 'tool') {
      const estado = c.state || {};
      bloques.push({
        type: 'tool_use',
        name: c.name || 'tool',
        id: c.id || null,
        text: JSON.stringify(estado.input == null ? {} : estado.input, null, 2),
      });
      const salida = Array.isArray(estado.content)
        ? estado.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n')
        : '';
      if (salida) {
        bloques.push({
          type: 'tool_result',
          id: c.id || null,
          isError: estado.status === 'error',
          text: salida,
        });
      }
    }
  }
  return bloques;
}

async function hilo(sessionId) {
  if (!disponible()) return null;
  const db = new DatabaseSync(DB, { readOnly: true, timeout: 2000 });
  try {
    const filas = db.prepare(`
      select type, seq, time_created, data
      from session_message
      where session_id = ? and type in ('assistant', 'user')
      order by seq
    `).all(sessionId);

    const mensajes = [];
    let i = 0;
    for (const fila of filas) {
      const data = parseJson(fila.data, {}) || {};
      const bloques = bloquesDeMensaje(data);
      if (!bloques.length) continue;
      const tokens = data.tokens || {};
      const cacheTokens = tokens.cache || {};
      mensajes.push({
        i: i++,
        role: fila.type,
        ts: iso((data.time && data.time.created) || fila.time_created),
        uuid: null,
        requestId: null,
        model: (data.model && data.model.id) || null,
        isSidechain: false,
        isToolReturn: false,
        injected: false,
        injectedKind: null,
        isConversation: bloques.some((b) => b.type === 'text'),
        blocks: bloques,
        usage: fila.type === 'assistant' ? {
          input: Number(tokens.input) || 0,
          output: Number(tokens.output) || 0,
          thinking: Number(tokens.reasoning) || 0,
          cacheRead: Number(cacheTokens.read) || 0,
          cacheWrite: Number(cacheTokens.write) || 0,
          costUSD: Number(data.cost) || 0,
        } : null,
      });
    }
    return mensajes;
  } finally {
    db.close();
  }
}

module.exports = { id: 'opencode', label: 'OpenCode', disponible, leer, hilo };
