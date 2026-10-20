'use strict';
const opencode = require('./opencode.cjs');
const codex = require('./codex.cjs');
const gemini = require('./gemini.cjs');

// Cada proveedor sabe leer SU formato y devuelve las mismas filas
// normalizadas que produce el lado Claude (session + request), para que el
// resto de la app (periodos, graficos, listas) no tenga que saber de donde
// salieron los datos.
const modulos = [opencode, codex, gemini];

function collect() {
  const sessions = [];
  const requests = [];
  const providers = [];

  for (const m of modulos) {
    const info = {
      id: m.id,
      label: m.label,
      disponible: false,
      sessions: 0,
      requests: 0,
      conUso: false,
      conConversaciones: false,
      error: null,
    };

    if (!m.disponible()) {
      providers.push(info);
      continue;
    }

    try {
      const r = m.leer();
      sessions.push(...r.sessions);
      requests.push(...r.requests);
      info.disponible = true;
      info.sessions = r.sessions.length;
      info.requests = r.requests.length;
      info.conUso = r.sessions.some((s) => s.hasUsage);
      info.conConversaciones = r.sessions.some((s) => s.hasThread);
    } catch (e) {
      info.error = e.message;
    }
    providers.push(info);
  }

  return { sessions, requests, providers };
}

async function hilo(row) {
  const m = modulos.find((x) => x.id === row.provider);
  if (!m) return null;
  return m.hilo(row.sessionId);
}

module.exports = { collect, hilo, modulos };
