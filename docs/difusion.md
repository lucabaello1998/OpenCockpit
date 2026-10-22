# Difusión de OpenCockpit

Borradores listos para copiar y pegar. Regla de oro: **publicar donde ya hay
gente con el problema**, no en todos lados el mismo día. Un solo post bien hecho
por semana rinde más que cinco el mismo lunes.

Antes de publicar, verificar:

- [ ] El release tiene el instalador de la última versión.
- [ ] El README se ve bien en GitHub (banner, capturas, tabla de proveedores).
- [ ] Los topics del repo están puestos.
- [ ] Responder comentarios el primer día: es lo que hace que el post viva.

---

## 1. Show HN (inglés)

**Título:**

```
Show HN: OpenCockpit – Local dashboard for Claude Code, OpenCode, Codex and other AI CLIs
```

**Primer comentario (el autor publica esto enseguida):**

```
I use several AI coding tools at once and kept losing track of where the tokens
(and the money) were going: Claude Code writes JSONL transcripts, OpenCode has a
SQLite DB, Codex has its own JSONL + sqlite state, and so on.

OpenCockpit is an Electron app that reads those local files and puts sessions,
tokens, costs and full conversations in one panel. You can filter by tool or see
the sum. No backend, no account, no telemetry: it reads from disk and only makes
a network call for two explicit actions (refresh Claude limits, fetch pricing).

Things that were harder than expected:
- Deduplicating Claude requests across parent/child transcripts by message.id
  and requestId, and folding subagent usage into the root session.
- Codex token_count is cumulative, so you have to keep deltas.
- Gemini/Antigravity stores conversations as protobuf, so only session metadata
  is shown and the app says so instead of pretending.

Windows-only for now (unsigned NSIS installer, so SmartScreen complains), MIT.
Source: https://github.com/lucabaello1998/OpenCockpit
```

**Cuándo:** martes a jueves, 8-10 AM hora del Este (13-15 UTC). Ahí está la
audiencia de HN.

---

## 2. Reddit (inglés)

**Subreddits:** `r/ClaudeAI` (principal), después `r/ClaudeCode`, `r/opencode`,
`r/LocalLLaMA` (solo si el enfoque es "local-first, sin telemetría").

**Título:**

```
I built a local dashboard that reads Claude Code, OpenCode and Codex data in one place (no backend, no telemetry)
```

**Cuerpo:**

```
I run Claude Code and OpenCode side by side and got tired of not knowing how much
each one was actually costing me.

OpenCockpit is a desktop app (Electron) that reads what each tool already writes
to disk — Claude's JSONL transcripts, OpenCode's SQLite DB, Codex sessions,
Copilot/Cursor/Cline stores — and shows sessions, tokens, cost and full
conversations in one panel, with a provider filter to see one tool or the sum.

It doesn't log you in anywhere and doesn't send anything: the only network calls
are manual (refresh Claude usage limits, update the pricing table).

Currently Windows-only, MIT licensed, and the installer is unsigned so Windows
will warn you. Happy to hear what other tools you'd want supported.

Repo: https://github.com/lucabaello1998/OpenCockpit
```

Regla de Reddit: el título no puede sonar a publicidad. Nada de "🚀 Launching my
app". Y contestar cada comentario en la primera hora.

---

## 3. LinkedIn (español)

```
Los que usamos varias herramientas de IA a la vez vivimos con el mismo problema:
cada una guarda el consumo en un formato distinto y no hay forma de saber cuánto
estás gastando en total.

Claude Code deja transcripts JSONL. OpenCode guarda todo en un SQLite. Codex
tiene su JSONL + state.sqlite. Copilot, Cursor y Cline, cada uno lo suyo.

Armé OpenCockpit: una app de escritorio que lee esos archivos locales y muestra
sesiones, tokens, costos y conversaciones completas en un solo panel, con un
filtro para ver una herramienta o la suma.

Dos decisiones que me parecen las importantes:
· Sin backend ni telemetría: la app lee archivos y no manda nada, salvo dos
  acciones que disparás a mano.
· Los números tienen que cerrar: deduplico requests por message.id y requestId,
  sumo los subagentes a la sesión raíz y, cuando la herramienta no registra
  costo, muestro tokens en vez de inventar dólares.

Está en GitHub, MIT, Windows por ahora:
https://github.com/lucabaello1998/OpenCockpit

Si lo probás, contame qué herramienta te falta.
```

**Cuándo:** martes o miércoles a la mañana. LinkedIn premia el texto plano (sin
links en el primer comentario, si es posible) y los primeros 60 minutos de
interacción.

---

## 4. GitHub

- Topics del repo: `electron`, `react`, `claude-code`, `opencode`, `codex`,
  `ai-tools`, `local-first`, `dashboard`, `developer-tools`.
- Release notes con una línea de "qué cambió" y una captura: el release se ve en
  el feed de quien te sigue.
- En el README, el link al release arriba de todo (ya está).

---

## Qué NO hacer

- No pedir estrellas ni votos (banea en Reddit y HN).
- No publicar el mismo texto en cinco lugares: HN detecta el crosspost y el
  título igual en todos lados se lee como spam.
- No prometer features que no están: si preguntan por Linux/macOS, decir que no
  está y anotarlo como pedido real.
