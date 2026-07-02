# Rally — Session State & Learnings

**Last updated:** v0.2.66 — remote session (Claude Code on the web, repo GitHub `guerrasur/rally-alpha`). Sistema de **Campaña offline** agregado y mergeado a `main`. Deploy automático a Firebase Hosting vía GitHub Actions agregado (falta que el usuario cargue el secret — ver sección DEPLOY).

⚠️ **Workflow de esta sesión remota (distinto a VS Code y a chat):** se trabaja sobre los 3 archivos split en `public/` dentro del repo git, con commits/push a una rama `claude/...` y PR a `main`. Para que el usuario teste (sin nada instalado), se le entrega un **HTML único fusionado** generado con python (style.css + game.js inline en index.html) vía SendUserFile — es solo una copia de prueba, la fuente de verdad es el repo.

### Incidente PR #1 (2026-07-02) — leer si el historial de main se ve raro
Al mergear el PR #1: (a) el merge en `main` tomó solo v0.2.63, NO los commits v0.2.64–66 que ya estaban pusheados en la rama; (b) apareció en `main` un commit "Revert…" con la cuenta del usuario que **no revertía nada** (solo agregaba un `.git-revert-marker`). El usuario confirmó que no fue él a propósito. Resolución: rama reconstruida desde `origin/main` + cherry-pick de v0.2.64–66 + borrado del marker, re-mergeado. LECCIÓN: después de mergear, verificar `git log origin/main` y diff contra la rama — no asumir que el merge tomó todo.

### v0.2.65 → v0.2.66
- **Partida de campaña aparece repentinamente, sin fade-in:** nueva clase `.screen.is-instant{transition:none}` que `Campaign.handlers.match` pone en `#screen-game` antes de `show('game')` y saca a los 400ms (para no matar transiciones futuras de esa pantalla).
- **Primer rival de campaña: "Tarata", 11 HP** (era Cachito 100 HP). Sigue skill 0.35.

### v0.2.64 → v0.2.65 (feedback del usuario probando)
- **`Campaign.hasProgress()` ahora exige ≥1 nodo completado** (node>0 o history no vacía). Antes, con solo haber confirmado el inicio (save en node 0 sin ganar nada) el botón ya decía "Continuar campaña" y salteaba el menú de confirmación con el desvanecimiento. Ahora ese menú se repite hasta ganar el primer nodo.
- **La campaña NO muestra el overlay de instrucciones "Cómo se juega"**: `Campaign.handlers.match` va directo a `show('game'); startGame()` en vez de `beginGame()` (pedido explícito: la primera partida de campaña tiene que arrancar de golpe). `beginGame._seen` queda intacto, así la primera partida rápida normal sí muestra el howto.

### v0.2.63 → v0.2.64 (bugfix, reportado por el usuario probando en navegador)
- **Fix — overlay de campaña visible de entrada y tapando la partida tras el fade:** `.camp-overlay{display:flex}` le ganaba al atributo `hidden` del HTML (la regla UA `[hidden]{display:none}` pierde contra cualquier regla de autor con display). Síntomas: el juego arrancaba mostrando el menú de campaña en vez del home, y tras el fade de 3s el overlay opaco nunca se ocultaba (la partida corría abajo, invisible). Fix: `.camp-overlay[hidden]{display:none;}`. LECCIÓN: si un contenedor con `hidden` tiene `display:` en CSS, siempre agregar la regla `[hidden]` explícita (el smoke test con DOM stub no lo detecta — es un bug de CSS, no de JS).

### v0.2.62 → v0.2.63 (this session)
- **NUEVO — Sistema de Campaña offline (bases):**
  - `CAMPAIGN_SCRIPT` (game.js, arriba de todo): cinta de nodos que se recorre en orden. Tipos hoy: `match` (partida vs CPU con `opp:{name,hp,skill,accent,emoji,dmgMult}` y `youHp` opcional) y `scene` (escena de texto sobre fondo plano, líneas que aparecen de a una vía `playScene()`). Extensible: registrar `Campaign.handlers.nuevoTipo = (node)=>{...; Campaign.advance();}` para animaciones/juegos internos futuros. Nodo 0 actual: partida vs Cachito idéntica a una partida rápida (a propósito — el CONCEPTO de la campaña es que parece normal y de a poco aparecen mecánicas/historia inesperadas; el usuario la irá escribiendo agregando nodos).
  - **Caché de progreso:** localStorage `rally_campaign_v1` → `{v,node,name,flags,history,startedAt,updatedAt}`. Se guarda al ganar cada nodo (`Campaign.completeCurrent()`, ANTES de la pantalla de resultado, así cerrar la app no pierde avance). `Campaign.setFlag/getFlag` para decisiones de historia futuras.
  - **UI:** botón `btn-campaign` en screen-offline — dice "Campaña" o "▶ Continuar campaña" si hay save (`updateCampaignBtn()`). Primera vez: overlay `camp-overlay` (fondo plano opaco --paper) "¿Comenzar campaña como (nombre)?"; al confirmar, `.camp-box.is-fading` desvanece el menú en 3s (transition opacity) dejando el fondo plano, y a los 3.6s arranca de golpe la partida del nodo 0. Con progreso: retoma directo en el nodo guardado, sin confirmar.
  - **Integración:** rama `Campaign.active` en `endGame` (ganar → "Continuar ▸" `btn-camp-next`; perder/empate → "Reintentar" mismo nodo), en `startGame` (hp de ambos), `applyOppCosmetic` (accent/nombre del nodo), `cpuDmgMult` (dmgMult del nodo), y nuevo `currentCpuSkill()` (campaña > torneo > 0.35) que reemplazó las 2 lecturas de skill duplicadas. `btn-leave`/`btn-home` llaman `Campaign.exitToMenu()` (sale del modo, el save queda). Fin de la cinta → escena "Continuará…" y NO borra el save (al agregar nodos, continúa desde ahí).
  - Nuevas pantallas en index.html: `screen-scene` (+`scene-text`/`scene-continue`) y `camp-overlay`; estilos al final de style.css (`.camp-*`, `.scene-*`).
  - Validado con `new Function(...)` + smoke test Node con DOM stub (flujo completo: confirmar → fade → partida → ganar → caché → continuar → "Continuará…" → resume).

### Sesión anterior (v0.2.62, VS Code + Claude Code extension)
This session ran entirely in VS Code + Claude Code extension (no chat/Design merge involved), working directly on the 3 split files in `public/`. No re-split needed. See "v0.2.61 → v0.2.62" section below for what changed.
**Working files (VS Code sessions):** `public/index.html` + `public/style.css` + `public/game.js` (repo root: `Rally - historico/Rally-alpha-0-2-61/`).
**Language:** All interaction with user (Lucio) in Argentine Spanish. Keep responding in Spanish.

⚠️ Note: the `/home/claude/...` and `/mnt/user-data/outputs/...` paths below are leftovers from the chat/Design-tool workflow (different session, different machine). They don't apply to VS Code sessions — ignore them when working locally.

⚠️ **RECURRING PATTERN — READ THIS EVERY SESSION:** User works across multiple tools (chat normal, Claude Design, VS Code w/ Claude Code extension) and each one outputs differently:
- Chat normal / Design → delivers a **single merged `.html` file** (style + script inline). Needs re-splitting into index.html/style.css/game.js (see recipe below).
- VS Code w/ Claude Code extension → user edits the **3 split files directly**, no merging needed.
**Always check what was uploaded first.** If it's a single `.html` file with `<style>` and `<script>` inline, it came from chat/Design and needs re-splitting. If 3 separate files were uploaded, it came from VS Code and can be used as-is. Compare the VERSION constant to the last-known version to catch how many versions were skipped in the other tool.

### Recipe to re-split a merged single-file upload into 3 files
(Confirmed working on both v0.2.58 and v0.2.60 uploads — line numbers WILL differ each time, always locate boundaries fresh, don't assume prior line numbers.)
```bash
# 1. Find the boundaries
grep -n "<style>\|</style>\|<script\|</script>" uploaded_file.html
# 2. Extract style.css (everything between <style> and </style>, exclusive)
sed -n 'STYLE_START+1,STYLE_END-1p' uploaded_file.html > style.css
# 3. Extract game.js (everything inside the LAST/large <script>...</script>, exclusive)
sed -n 'SCRIPT_START+1,SCRIPT_END-1p' uploaded_file.html > game.js
# 4. Build index.html: head (up to <style>) + link tag + body markup (between </style> and firebase <script src> tags) + firebase CDN tags (keep as-is) + <script src="game.js" defer> + closing tags
# 5. Validate:
node -e "const fs=require('fs');const js=fs.readFileSync('game.js','utf8');try{new Function('window','firebase','document','navigator','performance','requestAnimationFrame','cancelAnimationFrame','location','URLSearchParams',js);console.log('OK');}catch(e){console.log('ERR',e.message);}"
# 6. Cross-check id="..." in index.html vs $('...') calls in game.js (counts should be in the same ballpark, not exact since some ids are dynamic)
```

### v0.2.61 → v0.2.62 (this VS Code session)
- **Fix — online duel score desync (crítico):** `Net.listenDuelScores` (game.js) solo reenviaba `.pos` a `onOppDuelStop`, no `.score` — cuando el rival frenaba primero, `G.duel.oppScore` quedaba `null` y se computaba como 0 (daño mal calculado, host/guest terminaban con HP distinto). Fix: `onOppDuelStop(pos, score)` ahora recibe y guarda ambos.
- **Refactor — el minijuego decide el ganador, los buffs solo escalan el daño:** antes, quién ganaba el duelo se decidía comparando el daño YA CON BUFFS (`yourRealDmg`/`oppRealDmg`) — un jugador con puntaje más bajo en la barra de colores podía "ganar" si tenía buffs grandes. Ahora el ganador se decide SOLO por el puntaje crudo del minijuego (`rawYou` vs `rawOpp`, 0-20), en 3 lugares: `showDuelReveal`, `resolveDuel` (offline), `resolveDuelOnline`. El daño aplicado al HP sigue viniendo de `computeDuelDamages()`/`duelDamage()` con buffs incluidos — solo cambió QUIÉN gana, no CUÁNTO daño hace el ganador. `loserChipDamage()` se clampeó (`Math.min(1, loserDmg/winnerDmg)`) porque ahora el "perdedor" por puntaje puede tener daño buffeado mayor al del ganador (antes imposible). "Perfecto" sigue anulando ataque+defensa del rival sin cambios.
- **Rebalance de buffs** (partidas se estaban alargando): `powerDmgValue` 3→2→3 (probó 2, subió de nuevo), `powerDefValue` 3→2→1 (defensa bajada más que ataque, ya no decide quién gana el duelo). `maxPowerDmg`/`maxPowerDef` 6→4 (techo: +12 ataque / +4 defensa, antes +18 cada uno). `maxHp`/`downDamage` probados en 120/12, revertidos a 100/10 (default). Todo documentado en comentario al final de `CFG` en game.js.
- **NUEVO — chat en vivo (solo modos online):** panel plegable (botón flotante 💬 + badge de no leídos) en `#screen-game`, historial + input de texto. Infraestructura: `Net.pushChat`/`Net.listenChat`/`Net.stopChat` en `rooms/{code}/chat` (Firebase, push-id, `limitToLast(50)`). Objeto `Chat` (game.js) maneja la UI: `mount()`/`unmount()` según `G.online`, nunca aparece offline. Cubre salas 2p y torneo online (mismo `Net.ref` por match). Sin presets/emojis rápidos, texto libre.
- **Descubierto — mismatch de deploy target:** `.firebaserc` define target `rally` → site `rallyyy`, pero `firebase.json` apunta directo a site `rallyyy-test`. Si el usuario corre `firebase deploy --only hosting:rally`, deploya al site VIEJO (`rallyyy`), no al que se testea (`rallyyy-test`) — probablemente la causa de que cambios previos "no se vieran" tras deployar. Deploy correcto: `firebase deploy --only hosting` (sin target), respeta el `site` de `firebase.json`. Ver sección DEPLOY más abajo — puede necesitar corrección/alineación de `.firebaserc` a futuro.
- Todos los cambios validados con `node -e "new Function(...)"` sobre game.js. Usuario confirmó "anda" tras probar el chat online.

### v0.2.58 → v0.2.60 diff summary (found by diffing extracted game.js files)
Major addition: **online tournament system** — new `OT` object (~2177+ in game.js), new screen `screen-othub` (lobby/hub for online tournament rooms), bracket + match routing + spectator mode (`showLobby`, `renderHub`, `renderLobby`, spectate screen with `btn-spec-back`). This is a SEPARATE system from the existing offline `Tourney` object — don't confuse the two. Also: the old 1-on-1 online "revancha" (rematch) flow was replaced by a "volver a la sala" (`returnToRoom`, `btn-to-room`) flow — if backlog items reference "rematch," check whether they mean the old system (removed) or need adapting to the new room-return flow.
**This wasn't in the backlog at all** — likely a feature the user requested directly in the other session. Backlog status below was re-checked against v0.2.60 code; no other backlog items changed state between v0.2.58 and v0.2.60 (dark mode, poison mode, bracket rising-animation, bug #17 all still in the same state as before — see backlog section).

---

## FILE STRUCTURE (as of this session)
Split from the original single-file `rally.html` (3685 lines) into:
- **`index.html`** (~345 lines) — DOCTYPE, `<head>`, all HTML markup (screens, buttons, HUD, etc.), plus the two Firebase CDN `<script src>` tags and a `<script src="game.js" defer>` at the end.
- **`style.css`** (852 lines) — everything that was inside the old `<style>` block. Linked via `<link rel="stylesheet" href="style.css" />` in `<head>`.
- **`game.js`** (2486 lines) — everything that was inside the main game `<script>` block (VERSION const, firebaseConfig, CFG, all game logic). Loaded with `defer` so it runs after the DOM parses, equivalent to its old position at the end of `<body>`.

**Why:** user doesn't use a code editor and was pasting full 3000+ line HTML into chat for every tweak, burning tokens. Splitting means most edits only touch `game.js` (or a smaller section of it), and CSS-only tweaks only touch `style.css` — much cheaper to work with in chat, and the user can eventually open individual files in a text/code editor without scrolling through unrelated markup/styles.

**All 3 files must be delivered together** for the game to work (index.html references the other two by relative path). When only one file changes, still redeliver all three (or at least clearly state which changed) so the user doesn't mix mismatched versions.

---

## WORKFLOW (follow every time)
User is token-conscious. Work incrementally, ONE change set at a time, validate before delivering.
Per new version:
1. Make edits in the relevant file(s): `/home/claude/game.js` for logic, `/home/claude/style.css` for visuals, `/home/claude/index.html` for markup/screens.
2. Bump version string in `game.js` (`const VERSION = 'v0.2.XX'`) AND in `index.html` (`<title>` and `.version-tag` div — these two are now in a DIFFERENT file than VERSION, don't forget them).
3. Validate JS syntax directly (much cheaper now, no HTML to strip out):
   ```
   node -e "const fs=require('fs');const js=fs.readFileSync('game.js','utf8');try{new Function('window','firebase','document','navigator','performance','requestAnimationFrame','cancelAnimationFrame','location','URLSearchParams',js);console.log('OK');}catch(e){console.log('ERR',e.message);}"
   ```
4. Also run a feature-presence grep check for the specific edits.
5. Copy all 3 files to `/mnt/user-data/outputs/rally-split/` (overwrite).
6. `present_files` with all 3 paths.
7. Explain changes in Spanish; remind what's offline-testable vs needs hosting (2 devices) for online features.

For math-heavy changes (damage, AI aim, probabilities), write a standalone `node -e` simulation to verify before delivering. This has caught real bugs.

---

## DEPLOY (user does this from their Mac, NOT from phone)

**NUEVO (2026-07-02): deploy automático vía GitHub Actions** — `.github/workflows/firebase-deploy.yml` deploya a Firebase Hosting (site de `firebase.json` = `rallyyy-test`) en cada push/merge a `main`, usando `FirebaseExtended/action-hosting-deploy@v0`. **Requiere el secret `FIREBASE_SERVICE_ACCOUNT_RALLYE_ONLINE`** (JSON de cuenta de servicio, generado en Firebase console → Project settings → Service accounts → "Generate new private key") cargado en GitHub → repo Settings → Secrets and variables → Actions. Hasta que el usuario cargue ese secret, el workflow FALLA en cada push a main (esperable, no es un bug del código). Una vez cargado, ya no hace falta el CLI ni la Mac para deployar.
User canNOT deploy from phone. In the VS Code / local repo setup (`Rally - historico/Rally-alpha-0-2-61/`), files already live in `public/` (no copy step needed — edit in place).

⚠️ **Target mismatch found in v0.2.62 session:** `.firebaserc` defines target `rally` → site `rallyyy`, but `firebase.json` (`{"hosting":{"site":"rallyyy-test",...}}`) points directly at site `rallyyy-test`. Running `firebase deploy --only hosting:rally` deploys to the OLD site (`rallyyy`), NOT the one `firebase.json`/the user actually tests (`rallyyy-test`) — likely why past deploys looked like "changes didn't apply". **Correct command: `firebase deploy --only hosting`** (no target — lets it read `site` from `firebase.json`). Consider fixing `.firebaserc` to match `rallyyy-test` so the target alias works too, if the user wants that path available.

User HAS deployed and confirmed online works perfectly in production with the OLD single-file setup, up to v0.2.38-ish — "anda perfecto". In v0.2.62 session, user deployed the split structure and confirmed "anda" after testing the new online chat live — split structure works in production. Not 100% confirmed whether they used the corrected no-target command or the target alias; if online features seem stale again after a future deploy, check which deploy command was used first.

**Cannot host from phone.** Consumer Firebase console can't upload hosting files; needs CLI. Options given: deploy from computer (recommended). Lab panel is safe to ship (hidden behind secret access).

---

## FIREBASE
- Project `rallye-online`, Realtime Database (test-mode rules **EXPIRE 2026-07-30** — must replace before then or online breaks. This is the only hard-deadline item. Not yet done — user said "después lo probamos", wants to do it WITH live testing, not blind).
- Hosting: `firebase.json` points at site `rallyyy-test` directly (the one actually served/tested). `.firebaserc` target alias `rally` → site `rallyyy` (DIFFERENT site, stale/unused as of v0.2.62 — see DEPLOY section for the mismatch this caused).
- Compat SDK v10.12.2 (firebase-app-compat + firebase-database-compat).
- HAS_FIREBASE/DEMO flags; global `fbDb`.

### Online architecture (deterministic, host-authoritative-ish)
- Room at `rooms/{4-char-code}`. Host creates, guest joins.
- Board generated by host, serialized (CELL_CODE: e=empty, a=power_dmg, d=power_def, x=down, r=ring), pushed; guest mirrors 180° via `G.flip` + `viewCoord` (involutive). Both see themselves bottom-right.
- Moves: each writes `game/moves/{turn}/{role}`; both resolve identically when both present. Host cleans `moves/{turn-1}` to avoid DB buildup.
- Duel: each computes own score+pos locally, pushes `game/duels/{duelId}/{role}`; deterministic identical resolution. `duelId = 'd'+turnCount`.
- Eject (tie) decided by host, synced.
- `Net` object holds all Firebase methods + callbacks. `Net.leave()` cleans all listeners + nulls callbacks.
- Match mode synced via `game/mode`. Rematch via `rematch/{role}` flags. Presence via `presence/{role}` + onDisconnect, with 6s reconnection grace.

---

## GAME OVERVIEW
7x7 board (CFG.boardSize=7). Simultaneous moves (both pick adjacent cell, resolve together). Items: 🗡️ power_dmg (+damage buff), ◈ power_def (+defense buff), × down (trap), 💍 ring (rare heal). When players land adjacent/same cell → reflex duel (speedometer: stop needle in colored zones). Player bottom-right (n-1,n-1), opponent top-left (0,0).

### Key CFG values (editable live via Laboratorio) — UPDATED v0.2.62
boardSize 7, maxHp 100, **powerDmgValue 3 (was 3, dipped to 2, back to 3)**, **powerDefValue 1 (was 3, now nerfed — defense no longer decides who wins a duel, see refactor note above)**, **maxPowerDmg/Def 4 (was 6 — buff ceiling now +12 atk / +4 def, was +18/+18)**, downDamage 10, regenInterval 4, powerDmgCount/powerDefCount 3, downCount 4.
Duel: duelCycleDuration 1.8, duelMaxPasses 4.
Zones (needle position 0..1): green 0.46-0.54, yellow 0.40-0.60, orange 0.35-0.65, perfect 0.487-0.513 (hitbox enlarged from earlier 0.494-0.506). Scores: perfect 20, green 10, yellow 6, orange 4, orange2 3 (inner-orange, saves from red), redBase 2, redMin 1.
Ring: ringChancePerTurn 0.06, ringMinTurn 8, ringBigHeal 50, ringHealDiff 20, ringHealUnder 40, ringDripHeal 5, ringDripRounds 5.
**Duel winner logic (v0.2.62):** who wins is decided ONLY by raw minigame score (0-20) — buffs never affect this anymore, only the damage magnitude the winner deals. See `computeDuelDamages`/`duelDamage` in game.js.

---

## COMPLETED FEATURES (all in v0.2.42)

### Core / balance
- Damage buff chips red. Duel rounds count per half-sweep (ida=1, vuelta=2...). Reveal screen (showDuelReveal): two columns, color name + big number, verdict. Single-resolution guards (_duelResolved, _revealShown).
- **AI movement (cpuDecideMove):** traps penalized -14, only crossed if fully boxed-in (all neighbors traps) OR desperate-for-needed-buff (low HP + def available, or losing + dmg available). Anti-ping-pong: `G.opp.history` (last 4 cells, offline only) penalizes revisiting recent cells (-5/recency). Diagonals always available in getReachable.
  - **BUG #17 STILL OPEN:** user reported Alex still got stuck between 2 cells in tournament and never left (had to go get him, lost). Confirmed still-possible bug. HIGH priority.
- **CPU duel aim (scheduleCpuStop):** gaussian jitter (avg of 3 randoms, centers on green), aimSkill floor 0.3, coef 0.28. Red rates: skill0.3~47%, skill1~0% (75% green). Verified by simulation.
- **Perfect / súper golpe:** center zone 0.494-0.506, score 20 (double), dmg buffs doubled via `duelDamage(raw,pos,buffDmg,defDef,mult)` + `isPerfect(pos)`. Visual: repurposed `.speedo-center-mark` as thin 2px dark-green (`--perfect #14532D`) vertical line at 50%, opacity 0.7, top:0/bottom:0 (contained). Removed all flashy band/glow after user feedback (too flashy). Text "PERFECTO" in --perfect green. CPU perfect rates: skill0.3~2%, skill1~13%.
- **Loser chip damage (#9):** loser also deals proportional damage. `loserChipDamage(loserDmg,winnerDmg)=round(loserDmg*(loserDmg/winnerDmg)*0.5)`. LOSER_CHIP_FACTOR=0.5. Examples: 18v20→8, 8v9→4, 3v20→0. Both offline+online, verified consistent.
- **Tiro de gracia:** traps NEVER kill — `applyCellEffect` floors trap at `Math.max(1, hp-downDamage)` ALWAYS. `chipWithMercy(hp,chip)`: at 1 HP immune to chip; chip never drops winner below 1. Only LOSING a duel kills. Winning never kills.
- **Buff collision (#11):** `applySharedCellEffects()` — when both land same cell with buff/ring, deterministic draw `(turnCount*31 + x*7 + y*13) % 2` (identical on both online clients) gives it to one; toast "X se quedó con el ítem" (not for ring). Shared trap hits both.
- **Ring item (#15):** type 'ring' (code 'r'). Spawns once per game, rare (6%/turn after turn 8), NOT in tournament, sometimes not at all. `G.ringSpawned` flag reset each game. Pickup: if holder has 20+ HP less than rival AND <40 HP → +50 HP instant; else → +5 HP/round for 5 rounds (`player.ringDrip`, applied in resolveMoves via `applyRingDrip`). Multicolor 💍 with `ringGlow` animation. Spawn toast REMOVED (user request). Online: host generates, syncs via board.

### Offline / Tournament
- Offline menu: single "Offline" button on home → screen-offline with "Partida rápida" (btn-quick) + "🏆 Torneo offline". Quick-play CPU named **"Cachito"** (was 'CPU').
- Tournament: 8 rivals in TOURNEY_ROSTER (Madagascar-themed, each accent color + emoji + tag:'CPU'):
  Maurice(🐒 #2B8C4E), Mort(🐭 #D6A22B), Clover(🛡️ #1FA8A0 — was #2B4DE0 same-as-player blue, FIXED), Skipper(🐧 #5A6B7A), Kowalski(📐 #7A3BD6), Marlene(🦦 #D6577A, trait:'doubleStep'), Alex(🦁 #D6772B, trait:'hardHit'), Rey Julian(👑 #C8302B, trait:'luck' — no tilde, was "Rey Julián").
  HP exponential 10→200 (tourneyHpFor), skill exponential 0→1 (tourneySkillFor). Counter "🏆 Torneo · N/8" (tourney-bar) below HUD.
- **Rival traits (currentTrait()):**
  - hardHit (Alex): `cpuDmgMult()` returns 1.75, applied to opp's `duelDamage` in the 2 OFFLINE sites only (reveal + resolveDuel), NOT online.
  - doubleStep (Marlene): 30% chance to add distance-2 ring cells to CPU reachable in cpuDecideMove.
  - luck (Julian): `Tourney._duelCount`; every 5th duel, 50% chance to force perfect aim (sets oppScore=computeScore(pos,1) at center time). Plus his high skill already gives ~75% green.
- **Player HP carries between rounds:** `Tourney._carryHp` (null=fresh maxHp). Set on round win, reset on startTournament. Champion screen shows remaining HP; defeat shows how far you got.
- **Bracket "Mortal Kombat" screen (screen-bracket):** shown before each match via `showTourneyBracket(onGo)`. Your name+HP left, 8 rivals stacked right (reversed order, Julian/king on top in gold `.is-king`), beaten rivals struck-through red `.is-beaten`, current `.is-current`. `Tourney._beaten` tracks progress.

### Online (advanced)
- Simultaneous moves, synced duel, translucent rival needle.
- **Online tournament system (NEW in v0.2.60, not in prior backlog — confirm scope with user):** `OT` object — separate from offline `Tourney`. Room-based (`ref`, `code`, `mySeat`), player list synced (`players`), lobby (`showLobby`/`renderLobby`), hub screen (`screen-othub`, `renderHub`), bracket (`br`), match routing (`inMatch`, `myMatchId`, `matchA`/`matchB`, `master` flag for match authority), spectator mode (`spectate` screen, `stopSpec`, `btn-spec-back`), elimination tracking (`eliminated`, `finished`). Colors applied per-match via `applyColors`. NEEDS FULL REVIEW/TEST — appeared between sessions, not verified working end-to-end by this session.
- **1-on-1 "revancha" flow REPLACED:** old `setupOnlineRematch`/`btn-rematch` (both-must-accept flow) is gone, replaced by `setupOnlineEnd`/`returnToRoom`/`btn-to-room` — after a match, players return to the room/lobby instead of directly requesting a rematch. If old backlog items mention "rematch," verify against this new flow.
- **Immediate rival needle (v0.2.38):** `Net.onOppDuelStop` callback + `_oppShownThisDuel` shows rival's frozen needle as soon as their Firebase data arrives (via listenDuelScores per-rival check), not waiting for own stop. User wanted "see where rival's needle landed ASAP". Simplified onDuelScoresReady (removed iWasWaiting/"¡Frenó el rival!" msg).
- **Reconnection grace (#5):** presence watcher waits 6s before declaring abandonment; `onOpponentWaiting`/`onOpponentBack` show "⚠️ Rival desconectado — esperando…" / "Rival reconectado ✓".
- **Online rematch (#6):** `setupOnlineRematch` — both must accept via `rematch/{role}` flags; host generates new board. "Revancha (rival listo ✓)".
- **Best-of-5 (#6):** host picks "Partida única"/"Mejor de 5" in lobby (mode-single/mode-bo5 buttons, guest hides selector). App.matchMode synced via game/mode. BO5_TARGET=3. App.scoreYou/scoreOpp. setupNextRound auto-continues (host regenerates after 3s). "🏆 Ganaste la serie".
- **Opponent-moved indicator (#7):** `Net.onOppMoved` → "El rival ya eligió — te toca mover".
- **Stale room cleanup (#13):** `cleanStaleRooms()` deletes rooms >2hrs old, opportunistic on createRoom.
- **Invite link (#15-link):** btn-share generates `?sala=CODE` link (navigator.share/clipboard); `autoJoinFromURL` prefills code on load.
- **Messi easter egg (resolveSkins):** name "messi" (case-insensitive) → 🇦🇷 skin. Both messi → you KEEP 🇦🇷, rival shows 🇧🇷 named "Vinicius" (capital V). FIXED in v0.2.39 (previously lost own flag + lowercase vinicius).
- **Live chat (NEW v0.2.62, online-only):** collapsible panel (💬 floating button + unread badge) inside `#screen-game`. `Net.pushChat`/`listenChat`/`stopChat` write/read `rooms/{code}/chat` (push-id, `limitToLast(50)`). `Chat` object owns the UI (`mount()`/`unmount()` gated by `G.online` — never shows offline). Covers both 2p rooms and online-tournament matches (same `Net.ref`-per-match pattern). Free text input, no presets/emoji shortcuts. User-tested live, confirmed working ("anda").

### Robustness fixes (audit, v0.2.26)
- moves DB cleanup, countdown timers abort on phase change (`G.phase!=='duel-countdown'` guard, offline+online), leave() clears child listeners + nulls callbacks, CPU history offline-only, btn-leave sets G.phase='idle'.

### CPU tag (#16)
- `.hud-tag` is now plain gray text (font-body 11px, muted, opacity .7, no border/box). Content "(CPU)" beside opponent name. Tournament uses "(CPU)", online shows nothing (human), offline practice "(CPU)". Element id `hud-tag-opp`.

### Name cache
- `readName()` saves to localStorage 'rally_name'. On load, restores into name-input + App.playerName.

### 🧪 Laboratorio (debug panel, v0.2.37+)
- screen-lab, titled "🧪 Laboratorio" (named to avoid confusing with technical debug).
- `LAB_PARAMS` array (~17 balance params) → live sliders editing CFG. `CFG_DEFAULTS` for reset.
- Export/Import JSON (covers #13). "Restaurar valores" resets.
- **"💍 Spawnear anillo" button (v0.2.42):** places ring on empty cell in current game, syncs online.
- Hidden access: `?lab=1` URL OR 5 taps on version-tag (made clickable, id `version-tag`).
- "Volver" returns to game if G.running, else home.
- Safe to ship (hidden from normal players).

---

## MULTI-TOOL WORKFLOW (user alternates between chat, Design, and VS Code)
User now has 3 ways of working on this project:
1. **Chat normal / Claude Design** (token-limited) — outputs a single merged `.html`. Requires re-splitting on next handoff (see recipe above).
2. **VS Code + Claude Code extension** (local, own machine) — user opens the 3-file folder directly, no merging/splitting needed, Claude Code edits `game.js`/`style.css`/`index.html` in place with diff review.
3. Both tools may be used in the SAME version-to-version gap (e.g. v0.2.58→v0.2.60 skipped this session's chat entirely).

**Versioning stays folder-based regardless of which tool was used** — user copies the current version folder, renames it to the next version number, and works inside that copy (in VS Code) or uploads/downloads through chat. Always confirm which tool produced the current upload before assuming file structure.

---

## PENDING BACKLOG (priority order, from last discussion)
**Status column added this session** by diffing the actual v0.2.58 code against this list (doc was stale, last synced at v0.2.42 — 16 versions behind).

### HIGH (core mechanics / requested tweaks)
- **#20 — Perfect adjustments:** PARTIALLY DONE. `isPerfect(pos, pass)` already restricts perfect to pass 1 only (`if(pass !== undefined && pass !== 1) return false`) — confirmed in code. NOT confirmed: whether hitbox was enlarged, or whether red zone was rebalanced (extra orange worth 3 inside red, red worth less). Ask user or re-check `CFG` zone values before assuming done.
- **#19 — Tournament improvements:** PARTIALLY DONE.
  - HP carry between rounds: confirmed working (`Tourney._carryHp`), but this is just *conserving* HP, not *recovering/healing* extra HP after each battle — that part looks NOT done.
  - Bracket visual states (`is-king`, `is-beaten`, `is-current`) exist in `showTourneyBracket()`.
  - NOT found: player starting at bottom + "rising" one spot with animation on win, rivals hidden in black until unlocked with reveal animation, localStorage caching of which rivals are already unlocked. Likely NOT done — needs confirmation with user.
- **#17 — BUG: AI gets stuck between 2 cells and never leaves.** Anti-ping-pong logic (`G.opp.history`) still present, same shape as before — no evidence of a fix beyond what was already there. Likely STILL OPEN.

### MEDIUM
- **#21 — Dark mode:** NOT DONE. No trace of dark mode CSS/toggle/localStorage found in code.
- **#10 — Perfect blocks rival buffs:** NOT CONFIRMED — didn't specifically check this one this session, verify before starting other perfect-related work.

### MEDIUM-HIGH (big new mode)
- **#18b — Experimental modes menu + Modo Paredes (Walls):** DONE. Fully implemented: `wallsMode` flag, `enterWallsMode()`/`exitSpecialMode()`, `wallsBoardSize: 9`, `Walls.clear()`, dedicated buttons (`btn-walls`, `btn-walls-online`), even has an online variant. This item can be removed from backlog or moved to a "polish/bugfix" list if there are still issues with it.

### LOW
- **#18 — Modo Veneno (Poison):** NOT DONE. No trace found (`poison`/`veneno` search came up empty).

### NO DATE BUT CRITICAL
- **Firebase security rules** before 2026-07-30 (test rules expire). Still using default config in code (`rallye-online` project) — no evidence rules were touched. Do WITH live testing, not blind. This deadline is getting close — prioritize soon.

---

## USER PREFERENCES / STYLE LEARNINGS
- Wants minimal, integrated visuals — repeatedly asked to tone down flashy effects (perfect zone went from gold glow band → subtle dark-green center line; removed screen flash). Match existing translucent zone opacity (~0.38).
- Prefers to test offline between changes; deploys to hosting himself when ready.
- Likes being offered choices for design/mechanics decisions (used ask_user_input several times for damage formulas, needle behavior, etc.).
- Appreciates when I add debug/testing affordances (Lab panel, spawn ring button).
- Often batches multiple requests; wants them done "in one go" when small, but I should still work incrementally and validate.
- Asks me to maintain and reprioritize the backlog list as new ideas come.
