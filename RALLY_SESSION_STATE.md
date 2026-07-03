# Rally — Session State & Learnings

**Última actualización:** v0.2.77 — 2026-07-03, sesión remota (Claude Code on the web).
**Idioma:** todo con el usuario (Lucio) en español argentino.
Este archivo es la memoria entre sesiones: mantenerlo actualizado pero COMPACTO (el usuario cuida tokens — al agregar secciones nuevas, condensar o borrar lo viejo que ya no aplique).

## WORKFLOW (sesión remota)
- Se trabaja sobre los 3 archivos split en `public/` (index.html ~429 líneas, style.css ~1143, game.js ~3485), commits/push a una rama `claude/...` y PR a `main`.
- Para que el usuario teste (sin nada instalado): generar **HTML único fusionado** con python (style.css + game.js inline en index.html) y entregarlo vía SendUserFile — es copia de prueba, la fuente de verdad es el repo.
- Por versión: 1) editar, 2) bump `VERSION` en game.js + `<title>` y `.version-tag` en index.html **+ los `?v=` de los `<script>/<link>` en index.html (cache-busting, existe desde v0.2.74 — no olvidarlo o los usuarios ven JS nuevo con HTML viejo)**, 3) validar sintaxis:
  `node -e "const fs=require('fs');const js=fs.readFileSync('public/game.js','utf8');try{new Function('window','firebase','document','navigator','performance','requestAnimationFrame','cancelAnimationFrame','location','URLSearchParams',js);console.log('OK');}catch(e){console.log('ERR',e.message);}"`
- Screenshots de verificación: playwright-core (npm i en scratchpad) + Chromium preinstalado en `/opt/pw-browsers/chromium`, viewport 390px.
- Para cambios de matemática (daño, puntería, probabilidades): simulación standalone en node ANTES de entregar (caught real bugs; ver aisim v0.2.75).
- El usuario también trabaja en VS Code (edita los 3 archivos directo) y a veces en chat/Design (que entrega un solo .html fusionado). Si aparece un `.html` único con `<style>`/`<script>` inline: viene de chat/Design y hay que re-splitearlo (ubicar límites con `grep -n "<style>\|</style>\|<script"`, extraer con sed, validar con `new Function`). Siempre comparar la constante VERSION contra la última conocida para detectar versiones salteadas en otra herramienta.

## COLABORACIÓN EXTERNA (revisado 2026-07-03)
El usuario mencionó que un amigo creó "una rama" para aportar código. **Verificado en GitHub a esta fecha: NO existe** — en `guerrasur/rally-alpha` solo hay `main` + ramas `claude/...`, todos los commits/PRs son del usuario, y el único colaborador con acceso es `guerrasur`. Interpretación probable: el amigo hizo un **fork** (copia del repo en SU cuenta), que no aparece como rama acá, o todavía no pusheó nada.
Para integrar su aporte cuando aparezca: si es fork → que abra un Pull Request hacia `guerrasur/rally-alpha`; si quiere pushear ramas directo → el usuario debe invitarlo como colaborador (repo Settings → Collaborators). Próxima sesión: pedir al usuario el nombre de usuario de GitHub del amigo o el link a su rama/PR, y revisar PRs entrantes antes de asumir que no hay nada.

## DEPLOY
- **Automático vía GitHub Actions**: `.github/workflows/firebase-deploy.yml` deploya a Firebase Hosting en cada push/merge a `main`. Requiere el secret `FIREBASE_SERVICE_ACCOUNT_RALLYE_ONLINE` en GitHub (Settings → Secrets → Actions); hasta que el usuario lo cargue, el workflow falla en cada push (esperable, no es bug). Verificar en cada sesión si ya lo cargó.
- Site correcto: **`rallyyy`** (`firebase.json` target `rally` → `.firebaserc` mapea a `rallyyy`). `rallyyy-test` NO se usa (notas viejas decían lo contrario — corregido 2026-07-02). Manual: `firebase deploy --only hosting` desde la Mac del usuario (no puede deployar desde el teléfono).

## FIREBASE
- Proyecto `rallye-online`, Realtime Database. ⚠️ **Reglas test-mode EXPIRAN 2026-07-30** — único deadline duro; el usuario quiere hacerlo CON test en vivo, no a ciegas. Priorizar ya.
- Compat SDK v10.12.2 (app-compat + database-compat). Flags HAS_FIREBASE/DEMO, global `fbDb`.
- **Arquitectura online (determinista):** sala en `rooms/{código-4-chars}`, host crea / guest se une. Board lo genera el host, serializado (CELL_CODE: e/a/d/x/r; prefijo "W" = paredes) y el guest lo espeja 180° vía `G.flip` + `viewCoord` (ambos se ven abajo-derecha). Moves en `game/moves/{turn}/{role}`, resolución idéntica en ambos; host limpia `moves/{turn-1}`. Duelo: cada uno pushea score+pos a `game/duels/{duelId}/{role}` (`duelId='d'+turnCount`), resolución determinista. Empate/eject decide host. Objeto `Net` concentra todo; `Net.leave()` limpia listeners y anula callbacks. Modo en `game/mode`; presencia en `presence/{role}` + onDisconnect con 6s de gracia por reconexión. Chat en `rooms/{code}/chat` (push-id, limitToLast(50)).

## JUEGO — resumen y valores clave
Tablero 7x7 (paredes: 9), movimientos simultáneos. Ítems: 🗡️ power_dmg, ◈ power_def, × down (trampa), 💍 ring (heal raro). Adyacentes/misma casilla → duelo de reflejos (frenar aguja en zonas de color). Jugador abajo-derecha, rival arriba-izquierda.
- **CFG (v0.2.62+):** maxHp 100, powerDmgValue 3, powerDefValue 1, maxPowerDmg/Def 4 (techo +12 atk/+4 def), downDamage 10, regenInterval 4, counts 3/3/4. Duelo: duelCycleDuration 1.8, duelMaxPasses 4. Zonas (0..1): green .46-.54, yellow .40-.60, orange .35-.65, perfect .487-.513. Scores: perfect 20, green 10, yellow 6, orange 4, orange2 3, redBase 2, redMin 1. Ring: 6%/turno desde turno 8, +50 instant si <40 HP y 20+ abajo del rival, si no +5/ronda x5.
- **Ganador del duelo = SOLO puntaje crudo del minijuego** (0-20); los buffs solo escalan el daño (`computeDuelDamages`/`duelDamage`), en 3 sitios: showDuelReveal, resolveDuel, resolveDuelOnline. `loserChipDamage` clampeado a ≤ daño del ganador. PERFECTO solo en pase 1 (`isPerfect(pos,pass)`), anula ataque+defensa del rival, duplica buffs de daño propios.
- **Piedad:** trampas NUNCA matan (floor 1 HP), chip no mata (a 1 HP inmune al chip); solo PERDER un duelo mata.
- **Colisión de ítems en misma casilla:** sorteo determinista `(turnCount*31+x*7+y*13)%2` + ruleta visual rápida (~1.5s, v0.2.72). Trampa compartida golpea a ambos.
- **CPU/IA (v0.2.75, solo offline):** `cpuDuelAdvantage()` (HP+buffs de ambos+puntería) decide pelear/huir; gradiente hacia el ítem más valioso del tablero; anti-ping-pong con fallback a la casilla menos visitada + detector de ciclo A,B,A,B (bug #17 CERRADO, 0 ping-pongs en 600 partidas simuladas con aisim.js); duelo consciente del estado (desesperada → apunta pase 1 con puntería fina). Skill 0.35 quedó idéntico al viejo. Puntería: gaussian jitter, aimSkill floor 0.3, coef 0.28.
- **Veredicto de duelo (v0.2.72-76):** reveal "GANA {nombre}" (verde/rojo) + puntajes chicos "(6v3)"; pantalla final con barras de vida estilo HUD animadas (vacían desde HP previo al resultante, número cuenta en sincronía, colores is-low/is-mid, respeta reduced-motion, escala con maxHp real del rival).

## MODOS
- **Campaña offline (v0.2.63+):** `CAMPAIGN_SCRIPT` = cinta de nodos (tipos `match` con `opp:{name,hp,skill,accent,emoji,dmgMult}` y `youHp`; `scene` = texto línea a línea vía `playScene()`; extensible con `Campaign.handlers.nuevoTipo`). Progreso en localStorage `rally_campaign_v1`, se guarda al ganar cada nodo ANTES de la pantalla de resultado. `Campaign.setFlag/getFlag` para historia. Primer rival: **Tarata, 11 HP**, skill 0.35. `hasProgress()` exige ≥1 nodo ganado (si no, repite el menú de confirmación). Arranca de golpe (sin fade ni overlay de instrucciones; `beginGame._seen` intacto para partida rápida). Ganar → "Continuar ▸"; perder/empatar → "Reintentar". Salir no borra el save; fin de cinta → "Continuará…" y conserva save. Skill CPU: `currentCpuSkill()` = campaña > torneo > 0.35. El CONCEPTO: parece partida normal y de a poco aparecen mecánicas/historia inesperadas — el usuario la irá escribiendo.
- **Torneo offline:** 8 rivales TOURNEY_ROSTER (Madagascar): Maurice🐒, Mort🐭, Clover🛡️, Skipper🐧, Kowalski📐, Marlene🦦(doubleStep: 30% alcance 2), Alex🦁(hardHit: daño x1.75 offline), Rey Julian👑(luck: cada 5º duelo 50% perfect). HP 10→200 y skill 0→1 exponenciales. HP del jugador se conserva entre rondas (`Tourney._carryHp`). Pantalla bracket estilo Mortal Kombat (`showTourneyBracket`, `.is-king/.is-beaten/.is-current`).
- **Torneo online x4 (`OT`, v0.2.60):** sistema SEPARADO del Tourney offline — salas, hub (`screen-othub`), bracket, ruteo de matches, espectador. ⚠️ Nunca verificado end-to-end con dispositivos reales. El flujo 1-a-1 post-partida es "volver a la sala" (`returnToRoom`/`btn-to-room`) — el viejo rematch de ambos-aceptan fue REEMPLAZADO.
- **Modo Paredes (beta):** toggle `#walls-toggle` en lobby (solo host; partida única y bo5, NO torneo x4 — se apaga/oculta) + botón `btn-walls` en menú offline. Serialización online con prefijo "W" en board. Falta test online real con 2 dispositivos.
- **Modo oscuro (HECHO, ~v0.2.76-77):** toggle `btn-theme`, `data-theme` en `<html>`, localStorage `rally_theme`, claro por defecto. Anti-FOUC: script inline en `<head>` aplica tema + meta theme-color antes del primer paint (v0.2.77). Dorado de Rey Julián en bracket: #9A7B14 claro / #D4AF37 oscuro.
- **Chat online (v0.2.62):** panel plegable 💬 + badge no leídos en `#screen-game`, objeto `Chat` (`mount()/unmount()` según `G.online`, nunca offline). Cubre salas 2p y torneo online. Confirmado funcionando en producción.
- **🧪 Laboratorio:** acceso oculto `?lab=1` o 5 taps en version-tag. Sliders live sobre CFG, export/import JSON, reset, botón spawnear anillo. Seguro de shippear.
- Extras: easter egg "messi" (🇦🇷; ambos messi → rival 🇧🇷 "Vinicius"), nombre cacheado en localStorage `rally_name`, link de invitación `?sala=CODE`, limpieza de salas >2hs, indicador "el rival ya eligió".

## LECCIONES (leer antes de tocar código)
- **`[hidden]` vs CSS:** si un contenedor con `hidden` tiene `display:` en CSS de autor, agregar SIEMPRE la regla `[hidden]{display:none}` explícita (la regla UA pierde; el smoke test JS no lo detecta).
- **Flex centrado + contenido variable:** usar `margin:auto` en los hijos + `overflow-y:auto`, no `justify-content:center` (recorta contenido que desborda — bug "Salir cortado" del lobby).
- **Rings/bordes en móvil:** `box-shadow: inset` en vez de hacia afuera (el de afuera se recorta).
- **Después de mergear un PR, verificar `git log origin/main` + diff contra la rama.** Incidente PR #1 (2026-07-02): el merge tomó solo parte de los commits y apareció un commit "Revert" espurio con la cuenta del usuario que no revertía nada. Se reconstruyó la rama con cherry-pick. No asumir que el merge tomó todo.
- **Mismatch de caché HTML/JS** (duelo trabado v0.2.74): de ahí el cache-busting `?v=` por versión; mantenerlo al bumpear.
- Al versionar: el usuario copia la carpeta de la versión y la renombra — el versionado es por carpeta sin importar la herramienta.

## BACKLOG (repriorizado 2026-07-03)
- **CRÍTICO: reglas de seguridad de Firebase antes del 2026-07-30** (con test en vivo junto al usuario).
- **Cargar secret de deploy** `FIREBASE_SERVICE_ACCOUNT_RALLYE_ONLINE` (acción del usuario; recordárselo).
- **Testear en vivo (2 dispositivos):** torneo online x4 (`OT`) end-to-end y Modo Paredes online.
- **#19 Torneo — mejoras pendientes:** curación extra entre rondas (hoy solo conserva HP); jugador que "sube" un puesto con animación al ganar; rivales ocultos en negro hasta desbloquear + cache localStorage de desbloqueados.
- **#18 Modo Veneno:** no arrancado.
- **Campaña:** escribir nodos nuevos (historia del usuario) — la infraestructura está lista.
- Hechos y verificados (sacar de discusión): #17 vaivén IA (v0.2.75), #21 modo oscuro (v0.2.76-77), #10 perfecto anula buffs rivales, #20 perfecto solo pase 1, #18b Paredes, dark-mode FOUC.

## PREFERENCIAS DEL USUARIO
- Visuales mínimos e integrados — repetidamente pidió bajar efectos llamativos (el perfecto pasó de banda dorada con glow a línea finita; después volvió a dorado pero contenido dentro de la barra — avisar que puede pedir más notoriedad).
- Testea offline entre cambios; deploya él mismo cuando está listo. Cuida tokens: trabajar incremental, UN set de cambios por vez, validar antes de entregar.
- Le gusta que le ofrezcan opciones en decisiones de diseño/mecánica, y que se agreguen herramientas de testeo (Lab, spawnear anillo).
- Suele mandar varios pedidos juntos; hacerlos "de una" si son chicos, pero igual validar incrementalmente. Pide mantener y repriorizar este backlog.
