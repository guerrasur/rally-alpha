# Rally — Session State & Learnings

**Última actualización:** v0.3.43 — 2026-07-14, sesión remota (Claude Code). Fondo Game of Life en el menú de inicio (estético). *Archivo optimizado el 2026-07-16 (mismo contenido sustancial, menos tokens).*

**Idioma:** todo con Lucio en español argentino. **Memoria:** mantener este archivo COMPACTO — condensar/borrar lo viejo al agregar secciones nuevas.

## PENDIENTES DE LUCIO (probar en dispositivos reales)
- **Fin online v0.3.41 (2 celus):** (a) cerrar pestaña en pleno juego → el otro ve "rival desconectado", contador de auto-moves (1/3)… y victoria recién al 3ro; (b) volver ANTES del 3ro → la partida sigue para ambos; (c) volver DESPUÉS → derrota "Te desconectamos por inactividad", nunca partida viva ni victoria.
- **Nunca testeados en vivo:** torneo online x4 (OT) end-to-end, Modo Paredes online.
- **Confirmar en celu:** ritmo de EXP (v0.3.39), look de barra/flash de EXP (v0.3.36), y FPS del duelo con `?fps=1` (v0.3.37 — hipótesis: rAF de móvil <20fps + clamp `dt=0.05` → aguja "arrastrada"; si fps ok, es otra cosa).

## CHANGELOG (condensado, más reciente primero; detalle completo en los PRs)
- **v0.3.43** — 🧬 fondo Game of Life del menú (estético, pedido de Lucio): canvas `#gol-bg` tras `#screen-home`, células `--ink` opacidad CSS, tablero toroidal ~3.6 gen/s, estela `destination-out`, reseed anti-estancamiento, `dpr` tope 1.5. Vive/muere en `show()` (solo home), rAF congela en pestaña oculta, `prefers-reduced-motion` → frame estático. `z-index:0` + lift contenido (NO `z-index:-1`). ⚠️ `GolBg` debe declararse antes de `autoJoinFromURL` (TDZ). No toca reglas ni red.
- **v0.3.42** — 🔽 admin: secciones desplegables (solo `/admin/`, cosmético): `<details class="sect">` nativo por bloque, chevron rotante, cero JS nuevo. Visitas/Usuarios `open`, resto colapsado.
- **v0.3.41** — 🏁 fin online consistente (2 bugs de v0.3.40 en vivo): (1) caída de presencia con partida en curso ya no es fatal — solo avisa (`toastOppGoneAuto`), reloj sigue; watcher no se suelta al vencer gracia (`_oppGone`) → rival puede reenganchar. (2) Fin recién al 3er auto-move remoto consecutivo (`registerOppAutoMove`, `IDLE_MAX_STREAK=3`) → `endByOppIdle()` escribe `game/over {winner, reason:'idle'}` (first-write-wins), ganador conserva la sala (`Net._keepRoom`), el que vuelve ve su derrota, idempotente. (3) Salida deliberada sigue instantánea (nodo `guest` borrado / sala borrada). Reglas: nodo `over` en ambos espejos. Edge aceptado: marcador entre-rondas se ignora (guard `phase==='gameover'`). Verificado: emulador 10/10 + regresión 18/18; harness 57/57.
- **v0.3.40** — ⏰🌐 RPS "no elección" + barra · reloj global online: no elegir en 6s = sentinel `3` (chip ⏰), 3v3 → ruleta seed; barra `#rps-timer`. Offline sin límite (decisión de Lucio). **Reloj global** (fix "online no avanza en pestaña de fondo"): cliente PRESENTE escribe el dato faltante del rival al vencer plazos (move conveniente 15s, score 0 duelo ~8.6s, no-elección RPS +2.5s, eject de empate a los 4s). Todas las escrituras de intercambio van por `Net._setIfAbsent` (transaction solo-si-null). Historial de moves ya no se limpia por turno. Degradación aceptada: host ausente → sin regen ítems/OT. Reglas: rps 0..3. NO auto-elegía piedra — era al azar.
- **v0.3.39** — ⚖️ rebalance niveles/EXP: online 70/30, offline 50/22, práctica 25/12; curva `60+20·(niv-1)`. Nivel derivado del EXP total, sin migración.
- **v0.3.38** — 🪨📄✂️ fix desync buff compartido + disputa por RPS: seed decide `hostWins`, cada cliente traduce con `myAbsRole()`. Ítem compartido se disputa a RPS (`#rps-overlay`, empate → ruleta). Cada cliente sube su pick a `game/rps/{turno}/{rol}`. Otorgamiento diferido (`applySharedCellEffects` describe, `grantContestedItem` otorga).
- **v0.3.37** — 🩺 medidor FPS on-device (`?fps=1`). Descartado por medición: el clip del track re-rasteriza.
- **v0.3.36** — 🎖️ sistema niveles/EXP: `Exp` en `localStorage.rally_exp`, espejo `users/{uid}/exp` vía `transaction(Math.max)`. Otorga en `grantBattleExp` (anti-farmeo en rejugar campaña; empate=derrota). UI `#result-exp`. Reglas `exp` 0..1e8. Solo prestigio.
- **v0.3.35** — precarga sprite rival online en `resolveSkins()` (decode tardío trababa rAF).
- **v0.3.34** — skin propia visible en ficha del rival online (`host/guest/players.skin`).
- **v0.3.33** — revert overshoot FLIP (no volver a probar) + sin fx visual nuevo durante duel-play.
- **v0.3.32** — juiciness sutil: ghost bar, pop, conteo animado, `shakeBoard()`, stings, buff-chips. Descartado: trail de movimiento, hit-stop real, confetti.
- **v0.3.31** — perf carga: fonts por `<link>`+preconnect, SDKs con `defer`, cache `.webp`, `preloadSpriteAssets()`, DocumentFragment. Descartado: minificar game.js, renderBoard incremental.
- **v0.3.30** — fix "↺ Retomar torneo" no aparecía + heal-pop pegado en pantalla.
- **v0.3.29** — retomar torneo offline (`TourneyProgress`), curación 30% entre rondas, selector niveles campaña. Reglas: `tourneyProgress`.
- **v0.3.28** — precarga `tarata_move.webp` en `applyOppCosmetic()`.
- **v0.3.27** — caza de bugs: XSS nick (escHtml), `fillText` regex, listeners duplicados `listenBoard`, duelo fantasma tras abandono, `cleanStaleRooms` indexado, admin re-sync.
- **v0.3.26** — chat online mudo, toasts i18n, CPU "desesperada" %maxHp, fix Caos filtrándose a torneo x4.
- **v0.3.22-25** — skins ficha propia (catálogo `SKINS`), `localStorage.rally_skin` + `users/{uid}/skin`, fixes centrado/tamaño.
- **v0.3.15-21** — idioma ES/EN, SEO, fix aguja vs resize (`ResizeObserver`), sprites NPC fallback, crédito con link.
- **v0.3.04-14** — partidas rápidas (maxHp 100→35, bo3), Modo Caos completo, editor `/admin/`, onda azul duelo, fix serie bo3, no-cache HTML.
- **v0.2.6x-0.3.03** — fundaciones: auth anónima + reglas + deploy automático, login, chat, modo oscuro, modo Paredes beta, campaña/torneo offline, torneo online x4 (`OT`), Lab `?lab=1`, panel `/admin/`, stats, contador visitas, FLIP, espectador OT.

## LECCIONES (leer antes de tocar código)
- **Ningún avance online puede depender de timers/rAF del OTRO cliente** (v0.3.40): pestaña de fondo = setTimeout throttled + rAF congelado; presencia no lo detecta. Patrón: el presente arma el plazo y escribe el fallback del rival con `Net._setIfAbsent` (transaction solo-si-null); escrituras de intercambio NUNCA con `.set` — first-write-wins.
- **La caída de presencia NO es abandono** (v0.3.41): con partida en curso solo avisa; el fin llega por racha de 3 auto-moves, salida deliberada o KO. Todo fin unilateral deja `game/over` y conserva la sala (`_keepRoom`).
- **Emulador RTDB acá: jar DIRECTO** (`java -jar ~/.cache/firebase/emulators/firebase-database-emulator-*.jar`), NO `firebase emulators:start` (PUT de reglas cae en el proxy). Reglas/datos por `curl` (`/.settings/rules.json?ns=...&access_token=owner`); auth con JWT fake `alg:none` en `?auth=`. gstatic bloqueado en harness browser: servir bundles compat desde npm `firebase` vía `page.route`.
- **Determinista NO alcanza online: decisiones compartidas en rol ABSOLUTO** (host/guest, `myAbsRole()`; offline→'host'). Seed idéntico igual desincroniza si se mapea a `G.you/G.opp`. Patrones correctos: `onDuelScoresReady`/`onRpsPicksReady`, `pushEject`.
- **⚠️ Rendimiento del duelo — "barra lageada" reapareció 5 veces. NADA visual nuevo durante duel-play** (fx permitido: sonido+haptic). (1) Nunca animar en loop `box-shadow`/`filter`/`left`/`top` — solo `transform`/`opacity`. (2) Animación infinita nueva → sumar a `body.is-dueling{animation-play-state:paused}`. (3) Juego de abajo `visibility:hidden`; todo visible va DENTRO de `.duel-overlay`. (4) Toggle en `setDuelOverlayShown()`. (5) El throttle de CPU de CDP no reproduce raster de móvil.
- **`[hidden]` vs CSS:** si un contenedor con `hidden` tiene `display:` de autor, agregar `[hidden]{display:none}` explícito.
- **Centrado en el board:** `.cell` es flex-center pero NO centra hijos `position:absolute` — offset propio `left/top:(100-tamaño)/2%`, nunca `transform` (reservado a FLIP/`.is-clash`).
- **Sprites de ficha (`.has-sprite`):** `background-image: var(--sprite-url) !important`. NUNCA shorthand `background:` en reglas que puedan coincidir — usar `background-color`. Sprite nuevo dentro de animación corta → precarga `new Image().src` al arrancar.
- **Rings/bordes en móvil:** `box-shadow: inset`, no hacia afuera (se recorta).
- **Import de Design / rama vieja:** SIEMPRE `git fetch` + comparar main antes de aplicar; pisar archivos enteros revierte merges ajenos en silencio — aplicar delta real (diff 3 vías).
- **Verificar merge siempre:** tras mergear, `git log origin/main` + diff contra la rama.
- **Cache HTML/JS:** mantener `?v=` al bumpear. **Versionado:** el usuario copia/renombra la carpeta por versión.
- **Namespace del emulador:** `rallye-online-default-rtdb` (el corto crea namespace fake sin reglas — falso positivo silencioso).
- **`.transaction()` necesita permiso de LECTURA** además de escritura — contador global nuevo → `.read` puntual o falla en silencio.
- **`users/{uid}` es lectura solo-dueño** — info de otros usuarios va por `usernames/` (legible por autenticados) invertido en el cliente.
- **Mantener sincronizados:** `PARAMS`/`TEXT_PARAMS` del admin ↔ `LAB_PARAMS`/`TEXTS` de game.js (mismas claves y defaults).
- **Helpers de juice (v0.3.32) — usar, no duplicar:** `popClass`, `tweenNum` (cancela por `el._twnRaf`), `prefersReduced()`, `shakeBoard()`, `Sound.seq()`. Ghost bar se testea por estilos computados.

## REGLAS FIJAS DE WORKFLOW (no negociables)
1. **Mergear SIEMPRE automáticamente** al entregar — no dejar el PR abierto.
2. **No entregar HTML fusionado** — el merge a `main` alcanza (deploy automático).
3. **Actualizar este archivo SIEMPRE antes de mergear.**
4. **Revisar `database.rules.json` en la MISMA entrega** si el cambio toca algo que las reglas validan.

## WORKFLOW (sesión remota)
- 3 archivos split en `public/` (index.html, style.css, game.js); commits a rama `claude/...`, PR a `main`.
- Por versión: editar → bump `VERSION` en game.js + `.version-tag` y `?v=` en index.html → validar sintaxis con `node -e "new Function(...)"`.
- Screenshots: playwright-core + Chromium en `/opt/pw-browsers/`, viewport 390px. Matemática de juego: simular en node ANTES de entregar.
- Si llega un `.html` fusionado (Design/VS Code): re-splitear y comparar VERSION.

## DEPLOY / FIREBASE
- Deploy automático en cada push a `main`: hosting (`firebase-deploy.yml`) y reglas (`firebase-rules-deploy.yml` si cambia `database.rules.json`). Site **`rallyyy`** (`rallyyy-test` no se usa).
- Proyecto `rallye-online`, RTDB, reglas reales en producción. El proxy del entorno remoto bloquea `*.web.app`/`*.firebaseio.com` (sí permite `identitytoolkit.googleapis.com`) → reglas siempre con emulador local (ver LECCIONES).
- Panel `/admin/`: solo admins, bootstrap self-claim si `admins/` vacío, alta desde la UI, remoción solo por consola/`grant-admin.yml`.

## BACKLOG (repriorizado 2026-07-10)
- **i18n:** overrides remotos de `/admin/` solo aplican en ES; Lab sin traducir completo (uso interno).
- **Reglas:** endurecer campos compuestos (`moves`, `ejects`, `spec.A/B` sin `hasChildren`) — bajo impacto.
- **Niveles/EXP (hecho v0.3.36/39):** futuro — desbloquear skins por nivel, recompensas, bonus por torneo online completo, "Lv N" en HUD.
- **Stats (hecho v0.2.84):** futuro — logros reales, daño hecho/recibido en perfil, ranking/leaderboard.
- **Visitas (hecho v0.2.85):** futuro — nuevas vs recurrentes, por día/semana.
- **Login (hecho v0.2.79-80):** futuro — migrar progreso de localStorage a `users/$uid`; email real/Google para recupero.
- **Admin:** futuro — dominio propio, remoción de admins desde la UI, historial de cambios.
- **#19 Torneo:** curación extra entre rondas, animación al subir puesto, rivales ocultos. **#18 Modo Veneno:** no arrancado.
- **Campaña:** escribir nodos nuevos (infraestructura lista). **SEO:** sitemap.xml si se suman rutas.

## PREFERENCIAS DEL USUARIO
- Visuales mínimos e integrados (bajar efectos llamativos).
- Testea offline entre cambios; deploya vía merge automático. Cuida tokens: incremental, un set de cambios por vez, validar antes de entregar.
- Le gusta que le ofrezcan opciones en decisiones de diseño/mecánica, y herramientas de testeo (Lab, spawnear anillo, HUD de FPS).
- Suele mandar varios pedidos juntos; hacerlos "de una" si son chicos, validando igual incrementalmente. Mantener y repriorizar este backlog.
