'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const transcripts = require('../transcripts.cjs');

// GitHub Copilot Chat (extension de VS Code) guarda su historial en:
//   <globalStorage>/github.copilot-chat/session-store.db
// Tablas sessions + turns. No registra tokens ni costo: se listan sesiones y
// conversaciones, pero no suman al uso.
const REL = ['Code', 'User', 'globalStorage', 'github.copilot-chat'];

function candidatos() {
  if (process.env.COPILOT_DIR) return [process.env.COPILOT_DIR];
  const out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, ...REL));
  out.push(path.join(os.homedir(), '.config', ...REL));
  out.push(path.join(os.homedir(), 'Library', 'Application Support', ...REL));
  return out;
}

function base() {
  return candidatos().find((d) => fs.existsSync(path.join(d, 'session-store.db'))) || null;
}

function disponible() {
  return !!base();
}

let cache = { firma: null, data: null };

function firmaActual(db) {
  const st = (f) => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
  };
  return `${st(db)}|${st(db + '-wal')}`;
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

function leer() {
  const dir = base();
  if (!dir) return { sessions: [], requests: [] };
  const archivo = path.join(dir, 'session-store.db');
  const firma = firmaActual(archivo);
  if (cache.data && cache.firma === firma) return cache.data;

  const db = new DatabaseSync(archivo, { readOnly: true, timeout: 2000 });
  try {
    const sesiones = db.prepare('select * from sessions').all();
    const turns = db.prepare(`
      select session_id, turn_index, user_message, assistant_response, timestamp
      from turns order by session_id, turn_index
    `).all();

    const porSesion = new Map();
    for (const t of turns) {
      if (!porSesion.has(t.session_id)) porSesion.set(t.session_id, []);
      porSesion.get(t.session_id).push(t);
    }

    const herramientas = new Map();
    try {
      for (const h of db.prepare(`
        select session_id, tool_name, count(*) c from session_files
        where tool_name is not null group by session_id, tool_name
      `).all()) {
        if (!herramientas.has(h.session_id)) herramientas.set(h.session_id, {});
        herramientas.get(h.session_id)[h.tool_name] = h.c;
      }
    } catch { /* version sin session_files */ }

    const filas = [];
    for (const s of sesiones) {
      const suyos = porSesion.get(s.id) || [];
      if (!suyos.length) continue;
      const primerPrompt = suyos
        .map((t) => transcripts.cleanPrompt(t.user_message || ''))
        .find((x) => x && x.trim()) || null;
      const titulo = primerPrompt || (s.summary && String(s.summary).trim()) || '(sin título)';

      filas.push({
        sessionId: s.id,
        provider: 'copilot',
        providerLabel: 'GitHub Copilot',
        file: null,
        projectDir: null,
        cwd: s.cwd || null,
        gitBranch: s.branch || null,
        version: null,
        title: String(titulo).slice(0, 160),
        firstPrompt: primerPrompt,
        startedAt: iso(s.created_at) || iso(suyos[0] && suyos[0].timestamp),
        endedAt: iso(s.updated_at) || iso(suyos[suyos.length - 1] && suyos[suyos.length - 1].timestamp),
        userTurns: suyos.length,
        userTurnTimes: suyos.map((t) => iso(t.timestamp)).filter(Boolean),
        toolCounts: herramientas.get(s.id) || {},
        models: {},
        agents: { count: 0, subagents: 0, workflowAgents: 0, workflows: [] },
        sizeBytes: 0,
        hasThread: true,
        hasUsage: false,
        costKnown: false,
      });
    }

    const data = { sessions: filas, requests: [] };
    cache = { firma, data };
    return data;
  } finally {
    db.close();
  }
}

async function hilo(sessionId) {
  const dir = base();
  if (!dir) return null;
  const db = new DatabaseSync(path.join(dir, 'session-store.db'), { readOnly: true, timeout: 2000 });
  try {
    const turns = db.prepare(`
      select turn_index, user_message, assistant_response, timestamp
      from turns where session_id = ? order by turn_index
    `).all(sessionId);

    const mensajes = [];
    let i = 0;
    for (const t of turns) {
      const user = transcripts.cleanPrompt(t.user_message || '');
      if (user.trim()) {
        mensajes.push({
          i: i++,
          role: 'user',
          ts: iso(t.timestamp),
          uuid: null,
          requestId: null,
          model: null,
          isSidechain: false,
          isToolReturn: false,
          injected: false,
          injectedKind: null,
          isConversation: true,
          blocks: [{ type: 'text', text: user }],
          usage: null,
        });
      }
      if (String(t.assistant_response || '').trim()) {
        mensajes.push({
          i: i++,
          role: 'assistant',
          ts: iso(t.timestamp),
          uuid: null,
          requestId: null,
          model: null,
          isSidechain: false,
          isToolReturn: false,
          injected: false,
          injectedKind: null,
          isConversation: true,
          blocks: [{ type: 'text', text: t.assistant_response }],
          usage: null,
        });
      }
    }
    return mensajes;
  } finally {
    db.close();
  }
}

module.exports = { id: 'copilot', label: 'GitHub Copilot', disponible, leer, hilo };
