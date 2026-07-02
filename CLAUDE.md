# CLAUDE.md — Rally

Juego web (PWA) de tablero por turnos con duelos de reflejos, hecho por Lucio (`guerrasur`).
Vanilla JS + Firebase Realtime Database, servido como sitio estático por Firebase Hosting.
**Sin build, sin bundler, sin framework.** Los `.js` se cargan como scripts clásicos que comparten scope global.

> **Idioma:** toda la interacción con el usuario en **español rioplatense (Argentina)**.

---

## Estructura de archivos

Todo lo servido vive en `public/`:

```
public/
  index.html          markup: pantallas, HUD, botones, tags <script> (carga los js en orden)
  style.css           todos los estilos
  js/                 game.js (monolito de 3318 líneas) partido en módulos por dominio
    01-config.js         VERSION, firebaseConfig, App (estado app), modo Paredes, BO5
    02-tourney.js        torneo offline: TOURNEY_ROSTER, Tourney, traits, HP/skill por ronda
    03-campaign.js       campaña offline: CAMPAIGN_SCRIPT, Campaign, playScene, currentCpuSkill
    04-util.js           helpers DOM ($, show, toast, escapeHtml), Chat (online), Sound, haptic
    05-cfg.js            CFG: todos los parámetros de balance (editables en vivo por el Lab)
    06-board.js          G (estado de partida), tablero (build/render/serialize), Walls, velocímetro
    07-game-flow.js      flujo de partida: start, fase de elección, movimientos, IA (cpuDecideMove)
    08-duel.js           duelo de reflejos completo (offline + online): score, perfecto, daño, reveal
    09-hud-endgame.js    HUD, buffs, próxima ronda, fin de partida (endGame)
    10-net.js            Net: salas online 1v1 sobre Firebase (board sync, moves, duels, presencia)
    11-online-tourney.js OT: torneo online (lobby, hub, bracket, ruteo de matches, espectador)
    12-lab-bindings.js   beginGame, cosmética rival, bracket, arranque torneo, tema, Laboratorio,
                         y TODOS los event bindings de arranque + accesos ocultos (IIFE final)
```

### Cómo funciona el split (importante)
Los 12 archivos se cargan con `<script src="js/NN-...js" defer>` **en orden numérico**. `defer`
preserva el orden de ejecución y corre todo después de parsear el DOM. En scripts clásicos, los
`const`/`let`/`class` de nivel superior van a un **scope léxico global compartido** entre todos los
archivos, y `function`/`var` quedan en `window` — por eso todo sigue viéndose entre archivos sin
`import`/`export`. El split fue una **partición contigua**: concatenar los 12 en orden = el `game.js`
original byte a byte. No hubo cambios de comportamiento.

**Reglas al tocar los módulos:**
- El **orden de carga en `index.html` importa**. No lo cambies salvo que sepas por qué.
- `12-lab-bindings.js` debe cargar **último**: contiene los `addEventListener` de arranque y usa
  objetos definidos en todos los archivos anteriores.
- No dupliques un `const`/`let` de nivel superior entre archivos (rompe con "already declared").
- Si un módulo crece mucho, se puede volver a partir por función, pero mantené la partición contigua
  y el orden.

---

## Workflow por cambio

El usuario es consciente de los tokens: trabajar **incremental, un set de cambios por vez, validar antes**.

1. Editar el/los archivo(s) del dominio en `public/js/` (o `style.css` / `index.html`).
2. Bump de versión en **`js/01-config.js`** (`const VERSION`) **y** en `index.html` (`<title>` y `.version-tag`).
3. Validar sintaxis de los archivos tocados: `node --check public/js/<archivo>.js`
4. Smoke test de ejecución conjunta (detecta errores de scope global / bindings):
   ```bash
   cd public && node -e '
     const fs=require("fs"),f=["01-config","02-tourney","03-campaign","04-util","05-cfg","06-board","07-game-flow","08-duel","09-hud-endgame","10-net","11-online-tourney","12-lab-bindings"];
     const c=f.map(x=>fs.readFileSync(`js/${x}.js`,"utf8")).join("\n");
     new Function(c); console.log("parse OK");'
   ```
   (Para un smoke con stub de DOM que ejecute los bindings de arranque, ver historial de la rama `nacho`.)
5. Para cambios de matemática (daño, puntería IA, probabilidades): escribir una simulación `node -e`
   independiente antes de entregar. Ha cazado bugs reales.
6. Probar **offline** en el navegador. Lo online (salas, torneo online, chat) necesita hosting + 2 dispositivos.

---

## Deploy (lo hace el usuario desde su Mac, NO desde el teléfono)

⚠️ **Comando correcto: `firebase deploy --only hosting`** (sin target).
`firebase.json` apunta directo al site `rallyyy-test` (el que realmente se sirve/testea). El alias
target `rally` en `.firebaserc` apunta al site VIEJO `rallyyy` (obsoleto) — usar `--only hosting:rally`
deploya al site equivocado y "los cambios no se ven". Convendría alinear `.firebaserc` a `rallyyy-test`.

No se puede hostear desde el teléfono (la consola Firebase de consumo no sube hosting; necesita CLI).

---

## Firebase

- Proyecto `rallye-online`, Realtime Database, SDK compat v10.12.2 (`fbDb` global, flags `HAS_FIREBASE`/`DEMO`).
- ⚠️ **Reglas en test-mode EXPIRAN el 2026-07-30** — hay que reemplazarlas antes o lo online se rompe.
  Es el único deadline duro. Hacerlo CON testing en vivo, no a ciegas.
- **Online 1v1 (`Net`):** sala en `rooms/{code}` de 4 chars. El host genera y serializa el tablero
  (CELL_CODE: e/a/d/x/r), el guest lo espeja 180° (`G.flip` + `viewCoord`). Movimientos en
  `game/moves/{turn}/{role}`, duelos en `game/duels/{duelId}/{role}`, resolución determinista idéntica
  en ambos. Presencia con `onDisconnect` + 6s de gracia. Chat en `rooms/{code}/chat`.
- **Torneo online (`OT`):** sistema aparte del `Tourney` offline. Lobby/hub/bracket/espectador. Menos
  probado end-to-end — revisar si se toca.

---

## Overview del juego

Tablero 7×7 (`CFG.boardSize`). Movimiento simultáneo (ambos eligen casilla adyacente, se resuelve junto).
Ítems: 🗡️ power_dmg (+ataque), ◈ power_def (+defensa), × down (trampa), 💍 ring (cura rara).
Cuando quedan adyacentes/misma casilla → **duelo de reflejos** (velocímetro: frenar la aguja en zonas
de color; "perfecto" en el centro = puntaje doble). Jugador abajo-derecha (n-1,n-1), rival arriba-izq (0,0).
**Quién gana el duelo lo decide SOLO el puntaje crudo del minijuego (0–20)**; los buffs solo escalan
cuánto daño hace el ganador, no quién gana.

**Modos:** Offline (partida rápida vs "Cachito" / torneo offline 8 rivales / campaña / modo Paredes),
Online (1v1 / torneo online). Campaña: cinta de nodos (`CAMPAIGN_SCRIPT`) con progreso cacheado en
localStorage; parece una partida normal y va introduciendo mecánicas/historia de a poco.

**🧪 Laboratorio:** panel oculto de balance (sliders sobre `CFG`, export/import JSON, spawnear anillo).
Acceso: `?lab=1` o 5 toques en el tag de versión. Acceso a modos experimentales: `?beta=1` o 7 toques
en el logo. Seguro para producción (oculto).

---

## Backlog pendiente (prioridad)

**ALTA**
- **BUG #17:** la IA a veces se queda oscilando entre 2 casillas y no sale (pasó en torneo). Sigue abierto.
- **#19 torneo:** falta recuperar/curar HP extra tras cada batalla, y animaciones de "subir" en el bracket
  + rivales ocultos hasta desbloquear.
- **#20 perfecto:** revisar hitbox/rebalanceo de zona roja antes de más ajustes.

**MEDIA**
- **#21 dark mode:** existe `applyTheme` (12-lab-bindings) — verificar estado real / toggle.
- **#10:** ¿"perfecto" anula buffs del rival? confirmar.

**BAJA**
- **#18 modo Veneno:** no hecho.

**CRÍTICO SIN FECHA FLEXIBLE**
- Reglas de seguridad de Firebase antes del **2026-07-30**.

---

## Contexto / historia

`RALLY_SESSION_STATE.md` (raíz) es la bitácora larga de sesiones previas (cuando el proyecto se editaba
como archivo único o en 3 archivos). Tiene detalle fino de features ya hechas, decisiones de balance y
el patrón multi-herramienta del usuario (chat / Design / VS Code). Consultar ahí para "por qué" histórico;
este CLAUDE.md es la referencia de la estructura actual (post-refactor a módulos).
