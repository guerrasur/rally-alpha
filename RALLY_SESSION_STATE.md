# Rally — Session State & Learnings

**Última actualización:** v0.3.17 — 2026-07-10, sesión remota (Claude Code on the web).

## CHANGELOG (resumido, más reciente primero)
- **v0.3.17 — fix "la barra de duelo no va fluida" (reporte de Lucio):** las dos veces anteriores que se tocó esto (v0.2.95, luego `eceb631`) ya habían eliminado el layout-thrashing (transform en vez de `left`, ancho del track + nodos de las agujas cacheados una sola vez por duelo) — confirmado con Playwright que el rAF del duelo corre sólido a ~16.6ms/frame incluso con CPU throttling 6x, sin excepciones ni el loop trabándose. La causa real encontrada: `G.duel.trackWidth` se cacheaba UNA vez al arrancar el duelo (`buildSpeedometer()`) y nunca se actualizaba — si el ancho disponible cambiaba a mitad de duelo (rotar el celu, la barra del navegador mobile apareciendo/desapareciendo, zoom, split-screen), la aguja seguía moviéndose contra el ancho VIEJO mientras las zonas de color (hechas en %) sí seguían el ancho real → aguja desalineada/"corriéndose" de las zonas, lo cual se percibe como falta de fluidez. Reproducido con Playwright (`page.setViewportSize` a mitad de duelo: el track real bajó a 356px pero la aguja seguía calculando su posición contra 380px cacheados). Fix: `ResizeObserver` sobre `.speedo-track` (creado una sola vez, persiste entre duelos ya que el track nunca se destruye) que mantiene `G.duel.trackWidth` al día en vivo; la medición síncrona en `buildSpeedometer()` se conserva para el valor inicial correcto desde el primer frame. Sin cambios en la lógica de puntaje (`timeToPosition`/`computeScore` intactos). Validado: mismo test de resize ahora muestra el ancho cacheado convergiendo al real (~2px de margen por la naturaleza async del observer) en vez de quedar 24px desalineado; duelo completo (offline, auto-resolución a las 4 pasadas) sigue terminando en `duel-reveal` sin errores de consola.
- **v0.3.16 — bloque de crédito en "Cómo se juega":** `.page-credit` más chico (11px → 9px) y se agregó un link a `https://guerra-sur.web.app/` debajo de "Creado por lucio" (mismo tratamiento en TEXTS_EN vía `STATIC_I18N_EN['page-credit']`).
- **🌐 v0.3.15 — idioma ES/EN:** ícono de globo en `top-controls` (misma estética que el toggle luna/sol, mismo criterio de visibilidad: oculto en pantalla de partida). Si el jugador nunca eligió idioma, se detecta `navigator.language` ANTES del primer paint (script inline en `index.html`, mismo patrón que el tema): español → `es`, cualquier otro → `en` por defecto. Persiste en `localStorage.rally_lang`. Arquitectura: `TEXTS_ES` (el objeto de siempre, sigue recibiendo overrides remotos de `/admin/`) + `TEXTS_EN` (traducción estática, sin override remoto — **limitación conocida**: el panel de admin solo edita texto en español) + `TEXTS` como copia de trabajo repoblada por `refreshTexts()` según `LANG`. El HTML estático que nunca pasaba por `TEXTS` (botones, labels, placeholders) ahora tiene `id` y se traduce vía `STATIC_I18N_EN` + `applyStaticLang()` (cachea el español del propio DOM la primera vez). El Lab (`/admin/` testing) no se tradujo completo — bajo impacto, uso interno. Validado con Playwright: detección automática a inglés, toggle ES↔EN, persistencia post-reload, pantallas home/offline/lobby/info.
- **🔎 SEO — Verificación Search Console + meta tags:** propiedad `rallyyy.web.app` verificada vía archivo HTML (subido a `public/`, no a la raíz). `<title>` → "Rally - Partidas Online" + nuevo `<meta name="description">`. **Pendiente:** repuesta la cuota diaria, pedir indexación manual de `https://rallyyy.web.app`; evaluar `sitemap.xml` si se suman más rutas.
- **v0.3.14 — barra de duelo, 2do intento:** eliminado el costo de pintado restante del duelo: `perfectShine` ahora anima solo `opacity` vía `::after` (no `box-shadow`), y `body.is-dueling` oculta (`visibility:hidden`) todo el juego debajo del overlay durante el duelo. Validado 9/9.
- **v0.3.13 — barra de duelo lageada (Modo Caos):** las animaciones CSS infinitas de portales/bombas del Modo Caos competían con el rAF de la aguja. Fix: `setDuelOverlayShown(on)` pausa todos los loops decorativos del board durante el duelo. Validado 6/6.
- **v0.3.12 — MODO CAOS Fases 2-3 (final):** Bomba (arma al pisar, detona 2 turnos después, daño en área con piedad), Terreno alto (+2 daño en duelo), Botas (próximo movimiento a radio 2), CPU adaptada a los nuevos ítems, grupo "Modo Caos" en Lab/admin. Validado 20/20.
- **v0.3.11 — MODO CAOS Fase 1 (beta):** nuevo modo offline+online 1v1 excluyente con Paredes. Cofre sorpresa (daño/def/cura/trampa/teleport) y Portales (par, teleportan al gemelo). Viaja en el board string con prefijo `C~`, cero cambios a `database.rules.json`. Validado 30/30.
- **v0.3.10 — bug serie bo3 online:** el resultado de ronda se pasaba en <1s y la ronda 2 quedaba bugeada. Causa: `Net.listenStart()` disparaba con el board VIEJO ya en Firebase. Fix: `_lastBoardStr` congela el valor visto y solo un board distinto dispara `onStart`. Validado 19/19.
- **v0.3.09-08 — Partidas rápidas + serie mejor de 3:** `CFG.maxHp` 100→35 (Torneo offline queda en 100), serie online default "mejor de 3" (`BO5_TARGET` 3→2), puntos de ronda visuales, favicon nuevo, fix de "100 HP" hardcodeado visible antes de cargar, fix de cache (Firebase Hosting cacheaba el HTML hasta 1h → `no-cache` en `**/*.html`).
- **v0.3.04-07:** aviso visual de duelo inminente (onda azul entre casillas contiguas), limpieza de menú principal, ajuste de timing de la onda para no pisar animación de movimiento.
- **v0.2.97-3.03 — Editor del juego en `/admin/`:** editor de mapas (grilla clicable con paredes, valida conectividad BFS), editor de campaña (nodos escena/partida con mapa embebido), editor de personajes (roster de 8), Lab restringido a admins, animación de choque en misma casilla, textos del juego editables (`TEXTS`, 163 claves) con reglas y panel admin, refactor de duplicación de código (v0.2.98), fix botón de tema pisando HUD, pantalla de resultado de torneo mejorada (dorado/pulso/sonido/recap de HP).
- **v0.2.83-96 — Panel de admin + stats + visitas:** panel `/admin/` con login, acceso restringido a admins (bootstrap self-claim), sección para agregar admins, workflow `grant-admin.yml` (Admin SDK), estadísticas de jugador (`users/{uid}/stats`, 6 contadores online-only), contador de visitas del sitio, fix de stats que no se guardaban (auth async), fix de nombre sin límite de caracteres, animación FLIP para movimiento entre casillas (incl. diagonales), fix aguja de duelo trabada (`transform` en vez de `left`), fix mini-speedómetro del "Cómo se juega" (mismo patrón), globos "Vos"/rival al arrancar partida, espectador de torneo online ve el duelo en curso (no solo resultado).
- **v0.2.6x-0.2.82 y anteriores:** auth anónima + reglas definitivas de Firebase (primera publicación real, deploy automático de reglas y hosting vía GitHub Actions desde entonces), login real con usuario/contraseña, chat online, modo oscuro, modo Paredes (beta, sin test online real), campaña offline y torneo offline (8 rivales roster Madagascar), torneo online x4 (`OT`, nunca verificado end-to-end con dispositivos reales), Laboratorio de testing (`?lab=1`), fixes de login que se cerraba solo y "sala llena" fantasma.

## LECCIONES (leer antes de tocar código)
- **⚠️ Rendimiento del duelo — la "barra lageada" ya apareció 4 veces. Reglas acumuladas:** (1) NUNCA animar en loop `box-shadow`/`filter`/`left`/`top` — solo `transform`/`opacity` (+`will-change`); si hace falta pulsar una sombra, sombra ESTÁTICA + `::after` animando opacity. (2) Toda animación infinita nueva en una celda del board se suma al bloque `body.is-dueling{animation-play-state:paused}` de style.css. (3) Durante el duelo el juego de abajo queda `visibility:hidden` — si algo DEBE verse durante el duelo, va ADENTRO de `.duel-overlay`. (4) El toggle del overlay vive en `setDuelOverlayShown()` — nunca tocar `duel-overlay`/`is-show` directo. (5) El throttle de CPU de CDP NO reproduce jank de raster de móvil — no confiar en "acá se ve fluido" para descartar un reporte de celu.
- **`[hidden]` vs CSS:** si un contenedor con `hidden` tiene `display:` en CSS de autor, agregar SIEMPRE `[hidden]{display:none}` explícito.
- **Rings/bordes en móvil:** `box-shadow: inset`, no hacia afuera (se recorta).
- **Verificar merge siempre:** después de mergear, chequear `git log origin/main` + diff contra la rama — no asumir que tomó todo.
- **Cache HTML/JS:** de ahí el `?v=` por versión — mantenerlo al bumpear.
- **Versionado:** el usuario copia y renombra la carpeta de versión — es por carpeta, sin importar la herramienta.
- **Namespace del emulador Firebase:** `rallye-online-default-rtdb`, NO `rallye-online` (usar el corto crea un namespace fake sin reglas, falso positivo silencioso).
- **`.transaction()` de Firebase necesita permiso de LECTURA además de escritura** — si se agrega otro contador global con `.transaction()`, agregar su `.read` puntual explícito o falla en silencio.
- **`users/{uid}` es de lectura solo-dueño** — para mostrar info de OTROS usuarios (ej. nombres de admins), usar `usernames/` (legible por cualquier autenticado) invertido en el cliente, nunca leer `users/{uid}` ajeno.
- **Mantener sincronizados:** `PARAMS`/`TEXT_PARAMS` (admin) deben reflejar siempre `LAB_PARAMS`/`TEXTS` (game.js) — mismas claves y defaults.

## REGLAS FIJAS DE WORKFLOW (no negociables)
1. **Mergear SIEMPRE automáticamente** al entregar un update — no dejar el PR abierto esperando aprobación.
2. **No entregar HTML fusionado.** Con el merge a `main` alcanza: el deploy automático a Firebase Hosting lo publica.
3. **Actualizar este archivo SIEMPRE al terminar cada actualización, ANTES de mergear** — el merge nunca va sin este archivo al día.
4. **Revisar/actualizar `database.rules.json` en la MISMA entrega** cuando el cambio toca algo que las reglas validan — no dejarlo para después (el deploy de reglas es automático en cada push a `main`).

## WORKFLOW (sesión remota)
- Se trabaja sobre 3 archivos split en `public/` (index.html, style.css, game.js), commits/push a rama `claude/...` y PR a `main`.
- Por versión: 1) editar, 2) bump `VERSION` en game.js + `<title>` y `.version-tag` en index.html + los `?v=` de `<script>/<link>` (cache-busting), 3) validar sintaxis con `node -e "new Function(...)"` sobre game.js.
- Screenshots: playwright-core + Chromium, viewport 390px.
- Cambios de matemática (daño/puntería/probabilidad): simular standalone en node ANTES de entregar.
- Si el usuario trae un `.html` fusionado (viene de Design/VS Code): re-splitear y comparar VERSION contra la última conocida.

## DEPLOY
- **✓ Automático (desde 2026-07-02):** `.github/workflows/firebase-deploy.yml` deploya a Firebase Hosting en cada push/merge a `main`.
- **✓ Reglas de DB también automáticas (desde 2026-07-04):** `firebase-rules-deploy.yml` corre en cada push a `main` que modifique `database.rules.json`.
- Site: **`rallyyy`** (`firebase.json` target `rally` → `.firebaserc` → `rallyyy`). `rallyyy-test` no se usa.

## FIREBASE
- Proyecto `rallye-online`, Realtime Database. Reglas reales en producción desde v0.2.89 (antes test-mode).
- El proxy remoto bloquea `*.web.app`/`*.firebaseio.com` pero sí `identitytoolkit.googleapis.com`. Testear reglas siempre con emulador local.
- Panel admin `/admin/`: acceso restringido a admins, bootstrap self-claim si `admins/` está vacío, sección para agregar otros admins, sin remoción desde la UI (solo consola/workflow `grant-admin.yml`).

## COLABORACIÓN EXTERNA (revisado 2026-07-03)
Un amigo del usuario dijo haber creado "una rama" — verificado en GitHub, no existe (solo `main` + ramas `claude/...`, único colaborador `guerrasur`). Probable fork sin push aún. Próxima sesión: pedir su usuario de GitHub o link.

**Idioma:** todo con el usuario (Lucio) en español argentino.
Memoria entre sesiones: mantener COMPACTO (el usuario cuida tokens — condensar/borrar lo viejo al agregar secciones nuevas).

## BACKLOG (repriorizado 2026-07-10)
- **i18n:** overrides remotos de `/admin/` (`texts/`) solo aplican en español; Lab sin traducir completo (uso interno).
- **Endurecer validación de campos compuestos en `database.rules.json`:** `moves`, `ejects`, `spec.A/B` no fuerzan que el valor sea un objeto (`hasChildren`). Bajo impacto, no urgente.
- **📈 Visitas del sitio:** hecho (v0.2.85). A futuro: distinguir visitas nuevas vs. recurrentes, visitas por día/semana.
- **Estadísticas de jugador:** hecho (v0.2.84). A futuro: sistema real de logros, daño hecho/recibido en perfil del jugador, ranking/leaderboard.
- **Login real:** hecho (v0.2.79-80). A futuro: migrar progreso de localStorage a `users/$uid`; email real/Google para recupero de contraseña.
- **Panel de admin:** hecho y endurecido. A futuro: dominio/site propio (hoy `rallyyy.web.app/admin/`), remoción de admins desde la UI, historial de cambios de config.
- **Testear en vivo (2 dispositivos):** torneo online x4 (OT) end-to-end y Modo Paredes online — ninguno de los dos fue verificado con dispositivos reales todavía.
- **#19 Torneo:** curación extra entre rondas, animación al subir puesto, rivales ocultos hasta desbloquear.
- **#18 Modo Veneno:** no arrancado.
- **Campaña:** escribir nodos nuevos (infraestructura lista).
- **SEO:** sitemap.xml pendiente si se agregan más rutas navegables.

## PREFERENCIAS DEL USUARIO
- Visuales mínimos e integrados (bajar efectos llamativos).
- Testea offline entre cambios; deploya vía merge automático. Cuida tokens: incremental, un set de cambios por vez, validar antes de entregar.
- Le gusta que le ofrezcan opciones en decisiones de diseño/mecánica, y herramientas de testeo (Lab, spawnear anillo).
- Suele mandar varios pedidos juntos; hacerlos "de una" si son chicos, validando igual incrementalmente. Mantener y repriorizar este backlog.
