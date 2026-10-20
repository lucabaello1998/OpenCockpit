'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Gemini CLI / Antigravity. En esta version no hay ~/.gemini/tmp con chats
// legibles: las conversaciones viven en protobuf dentro de SQLite. Lo unico
// que se puede leer sin adivinar el esquema es el indice de conversaciones
// (titulo, proyecto, cantidad de pasos y fecha). Se listan igual, marcadas
// como "sin uso" y "sin transcripcion": es preferible eso a inventar tokens.
const DIR = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
const DB = path.join(DIR, 'antigravity', 'conversation_summaries.db');

let cache = { firma: null, data: null };

function disponible() {
  return fs.existsSync(DB);
}

function firmaActual() {
  try { const s = fs.statSync(DB); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

function fecha(valor) {
  if (!valor) return null;
  const d = new Date(String(valor).replace(' ', 'T'));
  return isNaN(d) ? null : d.toISOString();
}

function aRuta(uri) {
  try {
    const sinEsquema = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
    const normal = sinEsquema.replace(/^\/([A-Za-z]):/, '$1:');
    return path.win32.normalize(normal);
  } catch {
    return null;
  }
}

function leer() {
  const firma = firmaActual();
  if (cache.data && cache.firma === firma) return cache.data;

  const db = new DatabaseSync(DB, { readOnly: true, timeout: 2000 });
  try {
    const filas = db.prepare(`
      select conversation_id, title, preview, step_count, last_modified_time,
             workspace_uris, status, project_id, agent_name, parent_conversation_id
      from conversation_summaries
    `).all();

    const sessions = filas.map((f) => {
      let cwd = null;
      try {
        const uris = JSON.parse(f.workspace_uris || '[]');
        cwd = Array.isArray(uris) && uris.length ? aRuta(uris[0]) : null;
      } catch { /* sin workspace */ }

      const titulo = (f.title && String(f.title).trim()) ||
        (f.preview && String(f.preview).trim()) || '(sin título)';

      return {
        sessionId: f.conversation_id,
        provider: 'gemini',
        providerLabel: 'Gemini / Antigravity',
        file: null,
        projectDir: null,
        cwd,
        gitBranch: null,
        version: null,
        title: titulo.slice(0, 160),
        firstPrompt: f.preview ? String(f.preview).slice(0, 400) : null,
        startedAt: fecha(f.last_modified_time),
        endedAt: fecha(f.last_modified_time),
        userTurns: 0,
        userTurnTimes: [],
        toolCounts: {},
        models: {},
        agents: { count: 0, subagents: 0, workflowAgents: 0, workflows: [] },
        sizeBytes: 0,
        hasThread: false,
        hasUsage: false,
        costKnown: false,
        extra: { steps: f.step_count || 0, estado: f.status || null },
      };
    });

    const data = { sessions, requests: [] };
    cache = { firma, data };
    return data;
  } finally {
    db.close();
  }
}

async function hilo() {
  // El contenido esta en BLOBs protobuf sin esquema publico.
  return null;
}

module.exports = { id: 'gemini', label: 'Gemini / Antigravity', disponible, leer, hilo };
