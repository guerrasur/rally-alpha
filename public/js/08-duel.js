function startDuel(){
  G.phase='duel-countdown';
  $('duel-overlay').classList.add('is-show');
  $('duel-result').style.display='none';
  $('duel-game').style.display='none';
  $('duel-countdown').style.display='block';
  $('duel-title').textContent='¡Encuentro!';
  Sound.duelStart(); setMsg('Duelo inminente…');
  const btn = $('duel-stop');
  btn.classList.remove('is-active','is-pressed');
  btn.classList.add('is-visible');
  btn.disabled = true;
  const steps=[3,2,1,'¡YA!']; let i=0; const cd=$('duel-countdown');
  const tick=()=>{
    if(G.phase!=='duel-countdown') return;   // se salió/terminó: abortar
    if(i>=steps.length){ beginDuelPlay(); return; }
    cd.textContent=steps[i]; cd.classList.add('is-pop');
    Sound.countdown(); haptic(12);
    setTimeout(()=>cd.classList.remove('is-pop'),200);
    i++; setTimeout(tick, CFG.duelCountdownMs);
  };
  tick();
}

function beginDuelPlay(){
  G.phase='duel-play';
  $('duel-countdown').style.display='none';
  $('duel-game').style.display='flex';
  hideDuelReveal(); G._revealShown=false; G._duelResolved=false;
  if(G.duel.cpuTimer){ clearTimeout(G.duel.cpuTimer); G.duel.cpuTimer=null; }
  $('duel-title').textContent='Frená en verde';
  buildSpeedometer();
  G.duel.time=0;
  G.duel.pass=1;
  G.duel.stopped=false;
  G.duel.yourScore=null;
  G.duel.oppScore=null;
  G.duel.yourStopped=false;
  G.duel.oppStopped=false;
  G.duel.yourStoppedPos=0;
  G.duel.oppStoppedPos=0;
  G.duel.yourStoppedPass=undefined;
  G.duel.oppStoppedPass=undefined;
  updateNeedles(0);
  const btn=$('duel-stop');
  btn.classList.remove('is-visible','is-pressed');
  btn.classList.add('is-active');
  btn.disabled=false;
  updateDuelPassLabel();
  G.duel.lastTs=performance.now();
  const loop=(ts)=>{
    if(G.phase!=='duel-play') return;
    const dt=Math.min(0.05,(ts-G.duel.lastTs)/1000);
    G.duel.lastTs=ts;
    updateIndicator(dt);
    renderIndicator();
    G.duel.raf=requestAnimationFrame(loop);
  };
  G.duel.raf=requestAnimationFrame(loop);
  scheduleCpuStop();
}

// CORREGIDO: el tiempo SIEMPRE avanza mientras haya alguien sin frenar
function updateIndicator(dt){
  const anyoneStillPlaying = !G.duel.yourStopped || !G.duel.oppStopped;
  if(anyoneStillPlaying){
    G.duel.time += dt;
  }
  
  // Un "pase" = un tramo (medio ciclo): ida=1, vuelta=2, ida=3, vuelta=4.
  const half = CFG.duelCycleDuration / 2;
  const completedSweeps = Math.floor(G.duel.time / half);
  
  if(completedSweeps >= G.duel.pass){
    G.duel.pass = completedSweeps + 1;
    updateDuelPassLabel();
    
    if(G.duel.pass > CFG.duelMaxPasses){
      if(!G.duel.yourStopped){
        G.duel.yourScore=0;
        G.duel.yourStopped=true;
        G.duel.yourStoppedPos=timeToPosition(G.duel.time);
        G.duel.yourStoppedPass=CFG.duelMaxPasses+1;
        const btn=$('duel-stop');
        btn.disabled=true;
        btn.classList.remove('is-active');
        btn.classList.add('is-pressed');
      }
      if(!G.duel.oppStopped){
        G.duel.oppScore=0;
        G.duel.oppStopped=true;
        G.duel.oppStoppedPos=timeToPosition(G.duel.time);
        G.duel.oppStoppedPass=CFG.duelMaxPasses+1;
      }
      resolveDuel();
    }
  }
}

function updateDuelPassLabel(){
  const el=$('duel-pass');
  // La línea del perfecto solo tiene sentido en el 1er pase (ahí aplica el súper golpe).
  const mark=$('speedo-center-mark');
  if(mark) mark.style.display = (G.duel.pass===1) ? '' : 'none';
  if(G.duel.pass>CFG.duelMaxPasses){
    el.textContent='último pase';
    el.classList.add('is-danger');
    el.classList.remove('is-warn');
  } else if(G.duel.pass>=3){
    el.textContent=`pase ${G.duel.pass}/${CFG.duelMaxPasses}`;
    el.classList.add('is-warn');
    el.classList.remove('is-danger');
  } else {
    el.textContent=`pase ${G.duel.pass}/${CFG.duelMaxPasses}`;
    el.classList.remove('is-warn','is-danger');
  }
}

// CORREGIDO: siempre usar el tiempo actual (que sigue corriendo)
function renderIndicator(){
  const currentPos = timeToPosition(G.duel.time);
  updateNeedles(currentPos);
}

// La CPU apunta al verde con precisión proporcional a su skill
function scheduleCpuStop(){
  const skill = currentCpuSkill();
  const half = CFG.duelCycleDuration / 2;

  // Rasgo de Julián (luck): cada 5 duelos, 50% de chance de clavar el PERFECTO.
  const trait = currentTrait();
  if(trait==='luck'){
    Tourney._duelCount = (Tourney._duelCount||0) + 1;
    if(Tourney._duelCount % 5 === 0 && Math.random()<0.5){
      // Apuntar al centro exacto (perfecto) en el primer tramo de subida
      const perfectTime = half/2;  // centro del tramo 1 = posición ~0.5
      G.duel.cpuTimer = setTimeout(()=>{
        if(G.phase!=='duel-play'||G.duel.oppStopped) return;
        const pos = timeToPosition(G.duel.time);
        G.duel.oppScore=computeScore(pos, 1);
        G.duel.oppStopped=true; G.duel.oppStoppedPos=pos; G.duel.oppStoppedPass=1;
        if(G.duel.yourStopped) resolveDuel();
      }, perfectTime * 1000);
      return;
    }
  }

  // Apunta al centro (verde) de un tramo de subida (pases impares 1, 3).
  const targetPass = (Math.random() < 0.6) ? 1 : 3;
  const idealInSweep = half / 2;                     // centro del tramo (verde)

  // Piso de habilidad: ni el rival más débil apunta tan mal como para caer
  // casi siempre en rojo. Mantiene los duelos parejos.
  const aimSkill = Math.max(skill, 0.3);
  // Error con distribución cuasi-gaussiana (promedio de 3 randoms): concentra
  // las frenadas cerca del verde y hace raros los extremos (rojo).
  const gauss = ((Math.random()+Math.random()+Math.random())/3 - 0.5) * 2;
  const aimError = (1 - aimSkill) * half * 0.28 + 0.03;
  const jitter = gauss * aimError;
  let stopTime = (targetPass - 1) * half + idealInSweep + jitter;
  stopTime = Math.max(0.1, stopTime);
  const intendedPass = Math.floor(stopTime / half) + 1;

  G.duel.cpuTimer = setTimeout(()=>{
    if(G.phase!=='duel-play'||G.duel.oppStopped) return;
    const pos = timeToPosition(G.duel.time);
    const pass = Math.min(G.duel.pass, intendedPass);
    G.duel.oppScore=computeScore(pos, pass);
    G.duel.oppStopped=true;
    G.duel.oppStoppedPos=pos;
    G.duel.oppStoppedPass=pass;
    if(G.duel.yourStopped) resolveDuel();
  }, stopTime * 1000);
}

function computeScore(pos, pass){
  // El PERFECTO (súper golpe) solo cuenta en la PRIMERA pasada de la aguja.
  // En los pases 2-4, esa franja central cae como zona normal (verde, etc.).
  if(pass === 1 && pos >= CFG.duelPerfectStart && pos <= CFG.duelPerfectEnd){
    return CFG.perfectScore;   // ¡súper golpe!
  }
  if(pos >= CFG.duelGreenStart && pos <= CFG.duelGreenEnd){
    return CFG.greenScore;
  }
  if(pos >= CFG.duelYellowStart && pos <= CFG.duelYellowEnd){
    return CFG.yellowScore;
  }
  if(pos >= CFG.duelOrangeStart && pos <= CFG.duelOrangeEnd){
    return CFG.orangeScore;
  }
  // Naranja-interno: zona ancha que rodea al naranja; salva del rojo (vale poco).
  if(pos >= CFG.duelOrange2Start && pos <= CFG.duelOrange2End){
    return CFG.orange2Score;
  }
  const redScore = Math.max(CFG.redMinScore, CFG.redBaseScore - (pass - 1));
  return redScore;
}

// El perfecto solo aplica en el 1er pase. Necesita el pase para decidir.
// El perfecto solo aplica en el 1er pase. Necesita el pase para decidir.
function isPerfect(pos, pass){
  if(pass !== undefined && pass !== 1) return false;
  return pos >= CFG.duelPerfectStart && pos <= CFG.duelPerfectEnd;
}

// Daño real de un golpe: score + buffs propios − defensa rival.
// `perfect` (bool) indica si ESE golpe fue perfecto (ya considerando el pase).
// Si fue PERFECTO, los buffs de daño del atacante se DUPLICAN (el score 20 ya
// viene doblado desde computeScore).
function duelDamage(rawScore, perfect, attackerBuffDmg, defenderBuffDef, mult){
  const dmgBuff = perfect ? attackerBuffDmg*2 : attackerBuffDmg;
  let dmg = rawScore + dmgBuff - defenderBuffDef;
  if(mult && mult!==1) dmg = Math.round(dmg * mult);
  return Math.max(0, dmg);
}

// Cálculo central del duelo (#10): dado el estado de frenado de ambos, devuelve
// el daño de cada uno. Aplica la anulación de buffs por perfecto:
// - Si SOLO uno hace perfecto, ANULA los buffs del rival (su defensa no tapa el
//   golpe y su daño de buff no cuenta ese round) → perfecto "fuerte".
// - Si AMBOS hacen perfecto, los buffs cuentan normal (se define por buffs).
// Devuelve { yourDmg, oppDmg, youPerfect, oppPerfect }.
function computeDuelDamages(){
  const rawYou = G.duel.yourScore ?? 0;
  const rawOpp = G.duel.oppScore ?? 0;
  // Pase de frenado de cada uno. En online puede no venir: se infiere del score
  // (solo computeScore devuelve perfectScore, y solo en pase 1).
  const youPass = (G.duel.yourStoppedPass !== undefined) ? G.duel.yourStoppedPass
                  : (rawYou === CFG.perfectScore ? 1 : 2);
  const oppPass = (G.duel.oppStoppedPass !== undefined) ? G.duel.oppStoppedPass
                  : (rawOpp === CFG.perfectScore ? 1 : 2);
  const youPerfect = isPerfect(G.duel.yourStoppedPos, youPass);
  const oppPerfect = isPerfect(G.duel.oppStoppedPos, oppPass);

  // Buffs efectivos del rival, que el perfecto del otro puede anular.
  let youDefEff = G.you.buffs.def, youDmgEff = G.you.buffs.dmg;  // buffs del jugador
  let oppDefEff = G.opp.buffs.def, oppDmgEff = G.opp.buffs.dmg;  // buffs del rival
  if(youPerfect && !oppPerfect){
    // Mi perfecto anula los buffs del rival (defensa Y daño).
    oppDefEff = 0; oppDmgEff = 0;
  } else if(oppPerfect && !youPerfect){
    // El perfecto del rival anula MIS buffs.
    youDefEff = 0; youDmgEff = 0;
  }
  // Si ambos perfectos, no se anula nada (buffs cuentan normal).

  const yourDmg = duelDamage(rawYou, youPerfect, youDmgEff, oppDefEff);
  const oppDmg  = duelDamage(rawOpp, oppPerfect, oppDmgEff, youDefEff, cpuDmgMult());
  return { yourDmg, oppDmg, youPerfect, oppPerfect };
}
// Multiplicador de daño del rival CPU según su rasgo (Alex pega más fuerte)
function cpuDmgMult(){
  if(Campaign.active){
    const m = Campaign.matchOpt('dmgMult');
    if(m != null) return m;    // la campaña puede torcer el daño del rival
  }
  return currentTrait()==='hardHit' ? 1.75 : 1;   // 1.75x (entre 1.5 y 2)
}

// Daño de "consuelo" del perdedor del duelo: proporcional a qué tan cerca estuvo.
// = round( perdedorDmg × (perdedorDmg/ganadorDmg) × FACTOR ). Cuanto más cerca,
// más daño (la cercanía multiplica dos veces). Buffs ya incluidos en loserDmg.
// Quién es "perdedor" ahora lo decide el puntaje crudo, no este daño buffeado:
// por eso loserDmg puede superar a winnerDmg (rival flojo en el minijuego pero
// bien buffeado) — se clampea la cercanía a 1 para no romper la proporción.
const LOSER_CHIP_FACTOR = 0.5;
function loserChipDamage(loserDmg, winnerDmg){
  if(winnerDmg<=0 || loserDmg<=0) return 0;
  const cercania = Math.min(1, loserDmg / winnerDmg);     // 0..1
  return Math.round(loserDmg * cercania * LOSER_CHIP_FACTOR);
}
// "Tiro de gracia": un jugador en 1 HP no muere por el chip del perdedor.
// Solo perder un duelo (o una trampa) puede matarlo. Devuelve el chip efectivo.
function chipWithMercy(playerHp, chip){
  if(playerHp<=1) return 0;          // en 1 HP: inmune al chip
  return Math.min(chip, playerHp-1); // nunca lo baja a 0 por chip: piso en 1
}

// Devuelve la zona (nombre + color CSS) según la posición de frenado.
function zoneInfo(pos, pass){
  if(isPerfect(pos, pass))                                   return { name:'PERFECTO', color:'var(--perfect)', perfect:true };
  if(pos >= CFG.duelGreenStart && pos <= CFG.duelGreenEnd)   return { name:'Verde',   color:'var(--good)' };
  if(pos >= CFG.duelYellowStart && pos <= CFG.duelYellowEnd) return { name:'Amarillo',color:'var(--warn)' };
  if(pos >= CFG.duelOrangeStart && pos <= CFG.duelOrangeEnd) return { name:'Naranja', color:'var(--orange)' };
  if(pos >= CFG.duelOrange2Start && pos <= CFG.duelOrange2End) return { name:'Naranja', color:'var(--orange)' };
  return { name:'Rojo', color:'var(--bad)' };
}

function onPlayerStop(e){
  if(e) e.preventDefault();
  if(G.online){ onPlayerStopOnline(); return; }
  if(G.phase!=='duel-play'||G.duel.yourStopped) return;
  
  const pos = timeToPosition(G.duel.time);
  
  G.duel.yourScore=computeScore(pos, G.duel.pass);
  G.duel.yourStopped=true;
  G.duel.yourStoppedPos=pos;
  G.duel.yourStoppedPass=G.duel.pass;
  Sound.stop(); haptic(10);
  const btn=$('duel-stop');
  btn.disabled=true;
  btn.classList.remove('is-active');
  btn.classList.add('is-pressed');
  if(G.duel.oppStopped) resolveDuel();
}

const stopBtn = $('duel-stop');
if(window.PointerEvent){
  stopBtn.addEventListener('pointerdown', onPlayerStop, {passive: false});
} else {
  // Fallback para navegadores sin Pointer Events
  stopBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); onPlayerStop(); }, {passive:false});
  stopBtn.addEventListener('mousedown', onPlayerStop);
}

// Muestra, ARRIBA del velocímetro, dónde frenó cada uno (zona + color + puntaje)
// y quién gana por cuánto (buffs incluidos). El velocímetro sigue visible con
// las dos agujas congeladas. Dura ~2s antes del veredicto.
function showDuelReveal(){
  const rawYou=G.duel.yourScore??0, rawOpp=G.duel.oppScore??0;
  // Pase de frenado; si falta (rival online) se infiere del score (determinista).
  const youPassR = (G.duel.yourStoppedPass!==undefined)?G.duel.yourStoppedPass:(rawYou===CFG.perfectScore?1:2);
  const oppPassR = (G.duel.oppStoppedPass!==undefined)?G.duel.oppStoppedPass:(rawOpp===CFG.perfectScore?1:2);
  const zYou=zoneInfo(G.duel.yourStoppedPos, youPassR), zOpp=zoneInfo(G.duel.oppStoppedPos, oppPassR);
  const dmg=computeDuelDamages();
  const youPerfect=dmg.youPerfect, oppPerfect=dmg.oppPerfect;

  $('reveal-name-you').textContent=App.playerName;
  $('reveal-name-opp').textContent=App.oppName;
  const cYou=$('reveal-color-you'); cYou.textContent=zYou.name; cYou.style.color=zYou.color;
  const cOpp=$('reveal-color-opp'); cOpp.textContent=zOpp.name; cOpp.style.color=zOpp.color;
  const bYou=$('reveal-big-you'); bYou.textContent=`+${rawYou}`; bYou.style.color=zYou.color;
  const bOpp=$('reveal-big-opp'); bOpp.textContent=`+${rawOpp}`; bOpp.style.color=zOpp.color;
  // Resaltar el número grande si fue súper golpe
  bYou.classList.toggle('is-perfect-hit', youPerfect);
  bOpp.classList.toggle('is-perfect-hit', oppPerfect);

  // Quién gana el duelo lo decide SOLO el puntaje crudo del minijuego (0-20),
  // nunca los buffs: eso mantiene el minijuego totalmente independiente.
  const vEl=$('reveal-verdict');
  if(rawYou>rawOpp){
    const diff=rawYou-rawOpp;
    const sup = youPerfect ? '<b style="color:var(--perfect)">PERFECTO</b> · ' : '';
    vEl.innerHTML=`${sup}<b style="color:var(--good)">${App.playerName}</b> gana por <b>${diff}</b> (${rawYou} vs ${rawOpp})`;
  } else if(rawOpp>rawYou){
    const diff=rawOpp-rawYou;
    const sup = oppPerfect ? '<b style="color:var(--perfect)">PERFECTO</b> · ' : '';
    vEl.innerHTML=`${sup}<b style="color:var(--bad)">${App.oppName}</b> gana por <b>${diff}</b> (${rawOpp} vs ${rawYou})`;
  } else {
    vEl.innerHTML=`<b style="color:var(--warn)">Empate</b> (${rawYou} vs ${rawOpp})`;
  }

  // Feedback sutil si alguien hizo perfecto (sin flash de pantalla)
  if(youPerfect || oppPerfect){
    Sound.win && Sound.win();
    haptic([15,30,15]);
  }

  // El velocímetro (duel-game) sigue visible; solo añadimos el panel arriba.
  $('duel-stop').classList.remove('is-active');
  $('duel-reveal').style.display='flex';
  $('duel-title').textContent='Resultado';
  updateNeedles(G.duel.yourStoppedPos); // congelar agujas en su posición final
}
function hideDuelReveal(){ $('duel-reveal').style.display='none'; }

function resolveDuel(){
  if(G._duelResolved) return;        // ya resuelto: ignorar llamadas repetidas
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  // Paso 1: pantalla de revelado (zonas + quién gana). Paso 2: veredicto.
  if(!G._revealShown){
    G._revealShown=true;
    G.phase='duel-reveal';
    showDuelReveal();
    setTimeout(()=>{ resolveDuel(); }, 2200);
    return;
  }
  G._duelResolved=true;              // a partir de acá, no re-entrar
  $('duel-reveal').style.display='none';
  G.phase='duel-result';
  const rawYou=G.duel.yourScore??0, rawOpp=G.duel.oppScore??0;
  const _dmg=computeDuelDamages();
  const yourRealDmg=_dmg.yourDmg, oppRealDmg=_dmg.oppDmg;
  $('duel-score-you').textContent=rawYou; $('duel-score-opp').textContent=rawOpp;
  $('duel-label-you').textContent=App.playerName; $('duel-label-opp').textContent=App.oppName;
  const modsYou=$('duel-mods-you'), modsOpp=$('duel-mods-opp');
  modsYou.innerHTML=''; modsOpp.innerHTML='';
  if(G.you.buffs.dmg>0){ const m=document.createElement('span'); m.className='duel-score__mod is-atk'; m.textContent=`+${G.you.buffs.dmg}🗡️`; modsYou.appendChild(m); }
  if(G.opp.buffs.def>0){ const m=document.createElement('span'); m.className='duel-score__mod is-def'; m.textContent=`−${G.opp.buffs.def}◈`; modsYou.appendChild(m); }
  if(G.opp.buffs.dmg>0){ const m=document.createElement('span'); m.className='duel-score__mod is-atk'; m.textContent=`+${G.opp.buffs.dmg}🗡️`; modsOpp.appendChild(m); }
  if(G.you.buffs.def>0){ const m=document.createElement('span'); m.className='duel-score__mod is-def'; m.textContent=`−${G.you.buffs.def}◈`; modsOpp.appendChild(m); }
  // Quién ganó el duelo (y quién "es-winner" en pantalla) lo decide el puntaje
  // crudo del minijuego, no el daño ya modificado por buffs.
  $('duel-score-you').classList.toggle('is-winner', rawYou>rawOpp);
  $('duel-score-opp').classList.toggle('is-winner', rawOpp>rawYou);
  const titleEl=$('duel-result-title'), deltaEl=$('duel-delta');
  deltaEl.classList.remove('is-win','is-lose'); titleEl.classList.remove('is-win','is-lose','is-tie');
  let isTie=false;
  if(rawYou>rawOpp){
    const rawChip=loserChipDamage(oppRealDmg, yourRealDmg);
    const chip=chipWithMercy(G.you.hp, rawChip);   // tiro de gracia: ganar no te mata
    G.opp.hp=Math.max(0,G.opp.hp-yourRealDmg);
    G.you.hp=Math.max(0,G.you.hp-chip);
    titleEl.textContent='Ganaste el duelo'; titleEl.classList.add('is-win');
    deltaEl.classList.add('is-win');
    deltaEl.innerHTML = chip>0
      ? `Le hiciste <b>${yourRealDmg} de daño</b>. El rival te devolvió <b>${chip}</b>.`
      : `Le hiciste <b>${yourRealDmg} de daño</b> al rival.`;
    Sound.win(); haptic([15,30,15]);
  } else if(rawOpp>rawYou){
    const rawChip=loserChipDamage(yourRealDmg, oppRealDmg);
    const chip=chipWithMercy(G.opp.hp, rawChip);   // tiro de gracia: el rival ganador no muere por chip
    G.you.hp=Math.max(0,G.you.hp-oppRealDmg);
    G.opp.hp=Math.max(0,G.opp.hp-chip);
    titleEl.textContent='Perdiste el duelo'; titleEl.classList.add('is-lose');
    deltaEl.classList.add('is-lose');
    deltaEl.innerHTML = chip>0
      ? `El rival te hizo <b>${oppRealDmg} de daño</b>. Le devolviste <b>${chip}</b>.`
      : `El rival te hizo <b>${oppRealDmg} de daño</b>.`;
    Sound.lose(); haptic([20,60,20]);
  } else {
    isTie=true; titleEl.textContent='Empate'; titleEl.classList.add('is-tie');
    deltaEl.innerHTML='Ambos son expulsados en direcciones caóticas.'; Sound.tie();
  }
  G.you.buffs={dmg:0,def:0}; G.opp.buffs={dmg:0,def:0};
  G.justDueled = true;
  hideDuelReveal();
  $('duel-stop').classList.remove('is-visible','is-active','is-pressed');
  $('duel-result').style.display='flex'; $('duel-game').style.display='none';
  updateHud();
  setTimeout(()=>{
    $('duel-overlay').classList.remove('is-show');
    if(G.you.hp<=0||G.opp.hp<=0){ endGame(); return; }
    if(isTie) ejectPlayers();
    renderBoard(); updateHud(); startChoosePhase();
  }, 2600);
}

// ===== Duelo online (Etapa 3B) =====
// Modelo: cada cliente corre su propia aguja localmente; al frenar sube SOLO
// su score+posición. Con ambos scores, las dos pantallas calculan el mismo
// resultado de forma determinista (sin sincronizar la aguja en tiempo real).
function duelIdFor(){ return 'd'+G.turnCount; }

function startDuelOnline(){
  G.phase='duel-countdown';
  $('duel-overlay').classList.add('is-show');
  $('duel-result').style.display='none';
  $('duel-game').style.display='none';
  $('duel-countdown').style.display='block';
  $('duel-title').textContent='¡Encuentro!';
  Sound.duelStart(); setMsg('Duelo inminente…');
  const btn = $('duel-stop');
  btn.classList.remove('is-active','is-pressed');
  btn.classList.add('is-visible');
  btn.disabled = true;

  // Preparar escucha de scores del rival para este duelo
  const duelId = duelIdFor();
  Net.onDuelScores = onDuelScoresReady;
  // Mostrar la aguja del rival apenas frena (sin esperar a que yo frene)
  Net.onOppDuelStop = (pos, score)=>{
    if(G.duel.oppStopped) return;
    G.duel.oppStopped = true;
    G.duel.oppStoppedPos = pos;
    G.duel.oppScore = score;
    if(G.phase==='duel-play'){ Sound.stop && Sound.stop(); haptic(6); }
  };
  Net.listenDuelScores(duelId);

  const steps=[3,2,1,'¡YA!']; let i=0; const cd=$('duel-countdown');
  const tick=()=>{
    if(G.phase!=='duel-countdown') return;   // se salió/desconectó: abortar
    if(i>=steps.length){ beginDuelPlayOnline(); return; }
    cd.textContent=steps[i]; cd.classList.add('is-pop');
    Sound.countdown(); haptic(12);
    setTimeout(()=>cd.classList.remove('is-pop'),200);
    i++; setTimeout(tick, CFG.duelCountdownMs);
  };
  tick();
}

function beginDuelPlayOnline(){
  G.phase='duel-play';
  $('duel-countdown').style.display='none';
  $('duel-game').style.display='flex';
  hideDuelReveal(); G._revealShown=false; G._duelResolved=false;
  $('duel-title').textContent='Frená en verde';
  buildSpeedometer();
  G.duel.time=0;
  G.duel.pass=1;
  G.duel.yourScore=null;
  G.duel.oppScore=null;       // en online lo llena Firebase
  G.duel.yourStopped=false;
  G.duel.oppStopped=false;    // marcará true cuando llegue el score del rival
  G.duel.yourStoppedPos=0;
  G.duel.oppStoppedPos=0;
  G.duel.yourStoppedPass=undefined;
  G.duel.oppStoppedPass=undefined;
  updateNeedles(0);
  const btn=$('duel-stop');
  btn.classList.remove('is-visible','is-pressed');
  btn.classList.add('is-active');
  btn.disabled=false;
  updateDuelPassLabel();
  G.duel.lastTs=performance.now();
  const loop=(ts)=>{
    if(G.phase!=='duel-play') return;
    const dt=Math.min(0.05,(ts-G.duel.lastTs)/1000);
    G.duel.lastTs=ts;
    updateIndicatorOnline(dt);
    renderIndicator();
    G.duel.raf=requestAnimationFrame(loop);
  };
  G.duel.raf=requestAnimationFrame(loop);
  // No hay CPU: el rival es humano. Sus scores llegan por Firebase.
}

// Como updateIndicator pero sin lógica de CPU: si NO frenaste y se acaban los
// pases, tu score es 0. No tocamos el estado del rival (eso viene de Firebase).
function updateIndicatorOnline(dt){
  if(!G.duel.yourStopped){
    G.duel.time += dt;
  }
  const half = CFG.duelCycleDuration / 2;
  const completedSweeps = Math.floor(G.duel.time / half);
  if(completedSweeps >= G.duel.pass){
    G.duel.pass = completedSweeps + 1;
    updateDuelPassLabel();
    if(G.duel.pass > CFG.duelMaxPasses && !G.duel.yourStopped){
      // Se acabó el tiempo sin frenar: score 0
      const pos = timeToPosition(G.duel.time);
      commitMyDuelScore(0, pos);
    }
  }
}

function onPlayerStopOnline(){
  if(G.phase!=='duel-play'||G.duel.yourStopped) return;
  const pos = timeToPosition(G.duel.time);
  const score = computeScore(pos, G.duel.pass);
  commitMyDuelScore(score, pos);
  Sound.stop(); haptic(10);
}

// Registra mi resultado local y lo sube. Si ya tengo el del rival, resuelvo.
function commitMyDuelScore(score, pos){
  if(G.duel.yourStopped) return;
  G.duel.yourScore = score;
  G.duel.yourStopped = true;
  G.duel.yourStoppedPos = pos;
  G.duel.yourStoppedPass = G.duel.pass;
  const btn=$('duel-stop');
  btn.disabled=true; btn.classList.remove('is-active'); btn.classList.add('is-pressed');
  Net.pushDuelScore(duelIdFor(), score, pos).catch(e=>console.error('[duel] push', e));
  if(G.duel.oppStopped) resolveDuelOnline();
}

// Llegaron ambos scores desde Firebase. Mapear por rol y resolver.
function onDuelScoresReady(scores){
  const mine  = (Net.role==='host') ? scores.host  : scores.guest;
  const other = (Net.role==='host') ? scores.guest : scores.host;
  // Asegurar mi propio estado (por si resolví por timeout casi simultáneo)
  if(!G.duel.yourStopped){
    G.duel.yourScore = mine.score; G.duel.yourStopped = true; G.duel.yourStoppedPos = mine.pos;
  }
  G.duel.oppScore = other.score;
  G.duel.oppStopped = true;
  G.duel.oppStoppedPos = other.pos;
  resolveDuelOnline();
}

function resolveDuelOnline(){
  if(G._duelResolved) return;     // evitar doble resolución
  if(!(G.duel.yourStopped && G.duel.oppStopped)) return;
  // Paso 1: pantalla de revelado. Paso 2: veredicto.
  if(!G._revealShown){
    G._revealShown=true;
    if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
    G.phase='duel-reveal';
    showDuelReveal();
    setTimeout(()=>{ resolveDuelOnline(); }, 2200);
    return;
  }
  G._duelResolved = true;
  $('duel-reveal').style.display='none';
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  G.phase='duel-result';

  const rawYou=G.duel.yourScore??0, rawOpp=G.duel.oppScore??0;
  const _dmgO=computeDuelDamages();
  const yourRealDmg=_dmgO.yourDmg, oppRealDmg=_dmgO.oppDmg;
  $('duel-score-you').textContent=rawYou; $('duel-score-opp').textContent=rawOpp;
  $('duel-label-you').textContent=App.playerName; $('duel-label-opp').textContent=App.oppName;
  const modsYou=$('duel-mods-you'), modsOpp=$('duel-mods-opp');
  modsYou.innerHTML=''; modsOpp.innerHTML='';
  if(G.you.buffs.dmg>0){ const m=document.createElement('span'); m.className='duel-score__mod is-atk'; m.textContent=`+${G.you.buffs.dmg}🗡️`; modsYou.appendChild(m); }
  if(G.opp.buffs.def>0){ const m=document.createElement('span'); m.className='duel-score__mod is-def'; m.textContent=`−${G.opp.buffs.def}◈`; modsYou.appendChild(m); }
  if(G.opp.buffs.dmg>0){ const m=document.createElement('span'); m.className='duel-score__mod is-atk'; m.textContent=`+${G.opp.buffs.dmg}🗡️`; modsOpp.appendChild(m); }
  if(G.you.buffs.def>0){ const m=document.createElement('span'); m.className='duel-score__mod is-def'; m.textContent=`−${G.you.buffs.def}◈`; modsOpp.appendChild(m); }
  // Quién ganó el duelo (y quién "es-winner" en pantalla) lo decide el puntaje
  // crudo del minijuego, no el daño ya modificado por buffs.
  $('duel-score-you').classList.toggle('is-winner', rawYou>rawOpp);
  $('duel-score-opp').classList.toggle('is-winner', rawOpp>rawYou);
  const titleEl=$('duel-result-title'), deltaEl=$('duel-delta');
  deltaEl.classList.remove('is-win','is-lose'); titleEl.classList.remove('is-win','is-lose','is-tie');
  let isTie=false;
  if(rawYou>rawOpp){
    const rawChip=loserChipDamage(oppRealDmg, yourRealDmg);
    const chip=chipWithMercy(G.you.hp, rawChip);   // tiro de gracia: ganar no te mata
    G.opp.hp=Math.max(0,G.opp.hp-yourRealDmg);
    G.you.hp=Math.max(0,G.you.hp-chip);
    titleEl.textContent='Ganaste el duelo'; titleEl.classList.add('is-win');
    deltaEl.classList.add('is-win');
    deltaEl.innerHTML = chip>0
      ? `Le hiciste <b>${yourRealDmg} de daño</b>. El rival te devolvió <b>${chip}</b>.`
      : `Le hiciste <b>${yourRealDmg} de daño</b> al rival.`;
    Sound.win(); haptic([15,30,15]);
  } else if(rawOpp>rawYou){
    const rawChip=loserChipDamage(yourRealDmg, oppRealDmg);
    const chip=chipWithMercy(G.opp.hp, rawChip);   // tiro de gracia: el rival ganador no muere por chip
    G.you.hp=Math.max(0,G.you.hp-oppRealDmg);
    G.opp.hp=Math.max(0,G.opp.hp-chip);
    titleEl.textContent='Perdiste el duelo'; titleEl.classList.add('is-lose');
    deltaEl.classList.add('is-lose');
    deltaEl.innerHTML = chip>0
      ? `El rival te hizo <b>${oppRealDmg} de daño</b>. Le devolviste <b>${chip}</b>.`
      : `El rival te hizo <b>${oppRealDmg} de daño</b>.`;
    Sound.lose(); haptic([20,60,20]);
  } else {
    isTie=true; titleEl.textContent='Empate'; titleEl.classList.add('is-tie');
    deltaEl.innerHTML='Ambos son expulsados en direcciones caóticas.'; Sound.tie();
  }
  G.you.buffs={dmg:0,def:0}; G.opp.buffs={dmg:0,def:0};
  G.justDueled = true;
  hideDuelReveal();
  $('duel-stop').classList.remove('is-visible','is-active','is-pressed');
  $('duel-result').style.display='flex'; $('duel-game').style.display='none';
  updateHud();

  const duelId = duelIdFor();
  setTimeout(()=>{
    $('duel-overlay').classList.remove('is-show');
    G._duelResolved = false;
    if(G.you.hp<=0||G.opp.hp<=0){ endGame(); return; }
    if(isTie){
      // El host calcula las nuevas posiciones (usa azar) y las sincroniza
      if(Net.role==='host'){
        ejectPlayers();
        Net.pushEject(duelId, {x:G.you.x,y:G.you.y}, {x:G.opp.x,y:G.opp.y});
        renderBoard(); updateHud(); startChoosePhase();
      } else {
        // El guest espera las posiciones del host
        setMsg('Reposicionando…', true);
        Net.onEject = (e)=>{
          // e.youPos/oppPos están en perspectiva del HOST → para el guest se cruzan
          G.you.x=e.oppPos.x; G.you.y=e.oppPos.y;
          G.opp.x=e.youPos.x; G.opp.y=e.youPos.y;
          renderBoard(); updateHud(); startChoosePhase();
        };
        Net.listenEject(duelId);
      }
    } else {
      renderBoard(); updateHud(); startChoosePhase();
    }
  }, 2600);
}

