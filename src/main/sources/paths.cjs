'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const OPENCODE_DIR = process.env.OPENCODE_DATA_DIR || path.join(HOME, '.local', 'share', 'opencode');
const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const GEMINI_DIR = process.env.GEMINI_HOME || path.join(HOME, '.gemini');

const P = {
  HOME,
  CLAUDE_DIR,
  CLAUDE_JSON,
  OPENCODE_DIR,
  CODEX_DIR,
  GEMINI_DIR,
  opencodeDb: path.join(OPENCODE_DIR, 'opencode.db'),
  opencodeWal: path.join(OPENCODE_DIR, 'opencode.db-wal'),
  codexSessions: path.join(CODEX_DIR, 'sessions'),
  geminiSummaries: path.join(GEMINI_DIR, 'antigravity', 'conversation_summaries.db'),
  projects: path.join(CLAUDE_DIR, 'projects'),
  usageData: path.join(CLAUDE_DIR, 'usage-data'),
  sessionMeta: path.join(CLAUDE_DIR, 'usage-data', 'session-meta'),
  facets: path.join(CLAUDE_DIR, 'usage-data', 'facets'),
  settings: path.join(CLAUDE_DIR, 'settings.json'),
  settingsLocal: path.join(CLAUDE_DIR, 'settings.local.json'),
  mcpJson: path.join(CLAUDE_DIR, '.mcp.json'),
  mcpAuthCache: path.join(CLAUDE_DIR, 'mcp-needs-auth-cache.json'),
  statsCache: path.join(CLAUDE_DIR, 'stats-cache.json'),
  history: path.join(CLAUDE_DIR, 'history.jsonl'),
  hooks: path.join(CLAUDE_DIR, 'hooks'),
  skills: path.join(CLAUDE_DIR, 'skills'),
  workflows: path.join(CLAUDE_DIR, 'workflows'),
  plugins: path.join(CLAUDE_DIR, 'plugins'),
  plans: path.join(CLAUDE_DIR, 'plans'),
  graphifyHome: path.join(HOME, '.graphify'),
};

function readJSON(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// Los nombres de carpeta en ~/.claude/projects son una codificacion con guiones
// que es ambigua (no distingue "\" de "-"). El cwd real lo sacamos del transcript;
// esto es solo un fallback legible.
function prettifyProjectDir(name) {
  return name.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, '/');
}

module.exports = { P, readJSON, listDir, statSafe, prettifyProjectDir };
