# ARCHITECTURE — mapa función por función

Inventario de qué hace cada objeto/función dentro de cada módulo de `public/js/`.
El `CLAUDE.md` explica la estructura general y el "por qué" del split; **este archivo es el mapa de
navegación** para encontrar dónde vive cada cosa. Los números son referencia aproximada; si no coincide,
buscá por nombre.

> Recordá: todos los módulos comparten scope global (scripts clásicos con `defer`). Cualquier función
> puede llamar a otra de cualquier archivo. El orden de carga es 01 → 12.

---

## `01-config.js` — configuración y estado de la app
- `VERSION` — string de versión (bumpear acá en cada release, y también en `index.html`).
- `firebaseConfig`, `HAS_FIREBASE`, `DEMO`, `fbApp`, `fbDb` — credenciales y flags de Firebase.
- `App` — estado global de la app (nombre del jugador, si está online, modo Paredes, mute, etc.).
- `enterWallsMode()` / `exitSpecialMode()` — activan/desactivan el modo Paredes (cambian `boardSize`).
- `BO5_TARGET` — rondas para ganar una serie "mejor de 5" (=3).

## `02-tourney.js` — torneo offline
- `TOURNEY_ROSTER` — los 8 rivales (nombre, color accent, emoji, trait).
- `currentTrait()` — devuelve el rasgo especial del rival actual (hardHit / doubleStep / luck).
- `Tourney` — estado del torneo (activo, índice de rival, HP arrastrado, rivales vencidos).
- `tourneyHpFor(i)` / `tourneySkillFor(i)` — curvas exponenciales de HP (10→200) y skill (0→1) por ronda.

## `03-campaign.js` — campaña offline
- `CAMPAIGN_SAVE_KEY` — clave de localStorage del progreso (`rally_campaign_v1`).
- `CAMPAIGN_SCRIPT` — cinta de nodos de la campaña (tipos: `match`, `scene`). Se extiende agregando nodos.
- `Campaign` — motor de campaña: `advance()`, `completeCurrent()`, `setFlag`/`getFlag`, `exitToMenu()`,
  `handlers` (registrar tipos de nodo nuevos), caché de progreso.
- `currentCpuSkill()` — skill de CPU a usar (campaña > torneo > 0.35 por defecto).
- `playScene(lines, onDone)` / `_sceneTimers` — reproduce escenas de texto línea por línea.

## `04-util.js` — helpers de UI, chat, sonido
- `show(screen)` — cambia la pantalla visible (oculta las demás).
- `escapeHtml(s)` — escapa HTML (hay otra copia `escHtml` en el archivo 12; ojo con duplicado histórico).
- `toast(msg, ms)` / `toastT` — notificación efímera abajo.
- `Chat` — panel de chat en vivo (SOLO online): `mount()`/`unmount()`, render de mensajes, badge no-leídos.
- `genCode()` — genera código de sala de 4 chars.
- `Sound` — efectos de sonido del juego.
- `haptic(ms)` — vibración (si el dispositivo y el mute lo permiten).

## `05-cfg.js` — parámetros de balance
- `CFG` — **todos** los números editables del juego: tamaño de tablero, HP, valores/topes de buffs,
  daño de trampa, zonas del velocímetro, probabilidades del anillo, duración del duelo, etc.
  Es lo que el Laboratorio edita en vivo. Cambios de balance van casi siempre acá.

## `06-board.js` — estado de partida, tablero y velocímetro
- `G` — **estado de la partida actual** (jugadores, tablero, turno, fase, flags online). El objeto más central.
- `easeInOutCubic(t)` / `timeToPosition(time)` — curva de la aguja del velocímetro.
- `buildSpeedometer()` / `updateNeedles(pos)` / — construyen y mueven la aguja del duelo.
- `buildBoard()` — genera el tablero 7×7 con ítems.
- `cellAt(x,y)` / `countItems(type)` — acceso a celdas.
- `CELL_CODE` / `CODE_CELL` — mapeo celda↔letra para serializar el tablero en la red.
- `serializeBoard()` / `deserializeBoard(str)` — (de)serializan el tablero para sincronizar online.
- `viewCoord(x,y)` — espeja coordenadas 180° para el guest (que se ve abajo-derecha igual que el host).
- `regenerateItems()` — repone ítems durante la partida.
- `isMessi(name)` / `resolveSkins()` — easter egg de skins (Messi → 🇦🇷).
- `renderBoard()` — dibuja el tablero en el DOM.
- `Walls` — modo Paredes: genera/limpia paredes en tablero 9×9.
- `getReachable(x,y)` / `areAdjacentOrSame(a,b)` / `wallSeparates(a,b)` — reglas de movimiento y colisión.

## `07-game-flow.js` — flujo de partida + IA
- `startGame()` / `startOnlineGame(boardStr, role)` — arrancan una partida (offline / online).
- `ABANDON_MSGS` / `onOpponentLeft()` — manejo de rival que abandona.
- `startChoosePhase()` — abre la fase donde ambos eligen casilla.
- `onPlayerMove(x,y)` — el jugador eligió casilla.
- `onOnlineMovesReady(moves)` — llegaron los dos movimientos del turno (online).
- `cpuDecideMove()` — **IA de movimiento** (evalúa casillas, penaliza trampas y ping-pong). ← BUG #17 vive acá.
- `resolveMoves()` — resuelve el turno una vez elegidos ambos movimientos.
- `applySharedCellEffects()` — cuando ambos caen en la misma casilla con ítem (reparto determinista).
- `applyCellEffect(player)` — aplica el efecto de la casilla (buff/trampa) a un jugador.
- `applyRingDrip(player)` — cura por goteo del anillo.
- `ejectPlayers()` — resuelve empate expulsando a ambos.

## `08-duel.js` — duelo de reflejos (offline + online)
- `startDuel()` / `beginDuelPlay()` — arrancan el minijuego del velocímetro (offline).
- `updateIndicator(dt)` / `renderIndicator()` / `updateDuelPassLabel()` — loop de la aguja.
- `scheduleCpuStop()` — cuándo frena la CPU (jitter gaussiano según skill).
- `computeScore(pos, pass)` — puntaje 0–20 según dónde frenó la aguja.
- `isPerfect(pos, pass)` — si fue "perfecto" (centro, solo en pasada 1).
- `duelDamage(...)` — daño según puntaje + buffs + multiplicadores.
- `computeDuelDamages()` — calcula el daño de ambos en el duelo.
- `cpuDmgMult()` — multiplicador de daño de la CPU (trait hardHit de Alex = 1.75).
- `LOSER_CHIP_FACTOR` / `loserChipDamage(...)` — daño proporcional que también hace el perdedor.
- `chipWithMercy(hp, chip)` — "tiro de gracia": el chip nunca mata (piso en 1 HP).
- `zoneInfo(pos, pass)` — nombre/color de la zona donde frenó.
- `onPlayerStop(e)` / `stopBtn` — el jugador frena la aguja (binding del botón).
- `showDuelReveal()` / `hideDuelReveal()` — pantalla de revelación (dos columnas con resultados).
- `resolveDuel()` — resuelve el duelo offline y aplica daño.
- **Online:** `duelIdFor()`, `startDuelOnline()`, `beginDuelPlayOnline()`, `updateIndicatorOnline()`,
  `onPlayerStopOnline()`, `commitMyDuelScore()`, `onDuelScoresReady()`, `resolveDuelOnline()` —
  mismo duelo pero sincronizado por Firebase (resolución determinista idéntica en ambos clientes).
- **Regla clave:** quién GANA lo decide solo el puntaje crudo (0–20); los buffs solo escalan el daño.

## `09-hud-endgame.js` — HUD y fin de partida
- `updateHud()` — refresca barras de HP, nombres, contadores.
- `renderBuffs(elId, player)` — muestra los chips de buff de un jugador.
- `setMsg(text, active)` — mensaje de turno arriba.
- `setupNextRound()` — prepara la siguiente ronda (torneo / bo5).
- `setupOnlineEnd()` / `returnToRoom()` — fin de match online → volver a la sala.
- `endGame()` — **fin de partida**: decide ganador, ramifica según modo (rápida/torneo/campaña/online).

## `10-net.js` — red online 1v1 (`Net`)
Objeto único `Net` con toda la lógica de salas sobre Firebase. Guarda `ref`/`code`/`role` y callbacks.
Grupos de métodos:
- **Sala/arranque:** `listenStart` / `stopListenStart`, `onReady`, `onStart`.
- **Revancha:** `listenRematch` / `stopListenRematch`, `onRematchState`.
- **Movimientos:** `listenMoves(turn)`, `listenBoard` / `stopListenBoard`, `onMovesReady`, `onBoardUpdate`, `onOppMoved`.
- **Duelos:** `listenDuelScores(duelId)`, `listenEject(duelId)`, `onDuelScores`, `onEject`, `onOppDuelStop`.
- **Chat:** `listenChat` / `stopChat`, `onChatMessage`.
- **Presencia:** `startPresence` / `stopPresence`, `onOpponentLeft` / `onOpponentWaiting` / `onOpponentBack`
  (6s de gracia por reconexión).
- **Limpieza:** `detachMatch()`, `leave()` — sueltan listeners y anulan callbacks.

## `11-online-tourney.js` — torneo online (`OT`)
- `readName()` — lee/cachea el nombre del jugador (localStorage `rally_name`).
- `SEAT_COLORS` / `CPU_GRAY` / `CPU_NAMES` — colores por asiento y nombres de relleno CPU.
- `OT` — objeto del torneo online, **separado del `Tourney` offline**. Métodos:
  `setup()`, `showLobby()` / `renderLobby()`, `renderHub()`, `beginMatch()`, `simulate()`,
  `onMyMatchEnd()`, `spectate()` / `stopSpec()` / `renderSpec()`, `applyColors()`, `leaveTournament()`, etc.
  ⚠️ Menos probado end-to-end — revisar si se toca.

## `12-lab-bindings.js` — glue, tema, Laboratorio y bindings de arranque
- `escHtml(s)` — (duplicado de `escapeHtml`, histórico).
- `beginGame()` — entra a la pantalla de juego y arranca (usado por varios modos).
- `applyOppCosmetic()` — aplica color/nombre del rival según el modo.
- `showTourneyBracket(onGo)` — pantalla "Mortal Kombat" del bracket offline.
- `startTournament()` / `nextTourneyOpponent()` — arranque y avance del torneo offline.
- `onBothReady(info)` — ambos jugadores listos (online).
- `setModeUI(id)` — UI de selección de modo (single / bo5).
- `updateCampaignBtn()` — texto del botón de campaña ("Campaña" vs "▶ Continuar").
- `applyTheme(theme)` — aplica tema (dark mode — ver backlog #21).
- `LAB_PARAMS` / `CFG_DEFAULTS` / `buildLab()` / `openLab()` — 🧪 Laboratorio (sliders sobre CFG).
- **Al final del archivo:** TODOS los `addEventListener` de arranque + los accesos ocultos
  (`?lab=1` / 5 toques en versión; `?beta=1` / 7 toques en logo). **Por eso este archivo carga último.**
