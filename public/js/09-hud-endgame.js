function updateHud(){
  const oppMax = G.opp.maxHp || CFG.maxHp;
  const youPct=Math.max(0,Math.min(100,(G.you.hp/CFG.maxHp)*100));
  const oppPct=Math.max(0,Math.min(100,(G.opp.hp/oppMax)*100));
  $('hp-fill-you').style.width=youPct+'%'; $('hp-fill-opp').style.width=oppPct+'%';
  $('hp-num-you').textContent=Math.max(0,G.you.hp); $('hp-num-opp').textContent=Math.max(0,G.opp.hp);
  $('hp-fill-you').classList.toggle('is-low',youPct<25); $('hp-fill-you').classList.toggle('is-mid',youPct>=25&&youPct<55);
  $('hp-fill-opp').classList.toggle('is-low',oppPct<25); $('hp-fill-opp').classList.toggle('is-mid',oppPct>=25&&oppPct<55);
  $('hud-name-you').textContent=App.playerName;
  const tagEl=$('hud-tag-opp');
  const tBar=$('tourney-bar');
  if(Tourney.active){
    const r=TOURNEY_ROSTER[Tourney.index];
    $('hud-name-opp').textContent=(r.emoji?r.emoji+' ':'')+r.name;
    tagEl.textContent = '('+(r.tag || 'CPU')+')';   // texto gris al costado
    tBar.style.display='flex';
    $('tourney-count').textContent=`${Tourney.index+1}/${TOURNEY_ROSTER.length}`;
  } else if(G.online){
    $('hud-name-opp').textContent=App.oppName;
    tagEl.textContent='';                 // rival humano: sin tag
    tBar.style.display='none';
  } else {
    $('hud-name-opp').textContent=App.oppName;
    tagEl.textContent='(CPU)';            // práctica vs CPU
    tBar.style.display='none';
  }
  renderBuffs('hud-buffs-you',G.you); renderBuffs('hud-buffs-opp',G.opp);
}
function renderBuffs(elId,player){
  const el=$(elId); el.innerHTML='';
  const buffs=player.buffs;
  if(buffs.dmg>0){ const c=document.createElement('span'); c.className='buff-chip is-atk'; c.innerHTML=`<span class="sym">🗡️</span> +${buffs.dmg}`; el.appendChild(c); }
  if(buffs.def>0){ const c=document.createElement('span'); c.className='buff-chip is-def'; c.innerHTML=`<span class="sym">◈</span> +${buffs.def}`; el.appendChild(c); }
  // Efecto del anillo activo (goteo de curación): solo el ícono, sin texto.
  if(player.ringDrip && player.ringDrip>0){ const c=document.createElement('span'); c.className='buff-chip is-ring'; c.innerHTML=`<span class="ring-ic"></span>`; el.appendChild(c); }
}
function setMsg(text,active=false){ const el=$('turn-msg'); el.textContent=text; el.classList.toggle('is-active',active); }

// Revancha online: ambos deben aceptar. El host, al estar ambos listos,
// genera un board nuevo y reinicia (reusa el flujo de pushStart/listenStart).
// Mejor de 5: continuar a la siguiente ronda automáticamente.
function setupNextRound(){
  let rb = $('btn-rematch'); if(rb) rb.style.display='none';
  setMsg('');
  // Escuchar arranque de la próxima ronda
  Net.onStart = (boardStr)=>{
    Net.stopListenStart();
    startOnlineGame(boardStr, Net.role);
  };
  Net.listenStart();
  // El host genera el board de la nueva ronda tras una pausa para leer el marcador
  if(Net.role==='host'){
    setTimeout(()=>{
      Net.resetForRematch().then(()=>{
        buildBoard();
        Net.listenStart();
        Net.pushStart(serializeBoard());
      });
    }, 3000);
  } else {
    $('result-score').innerHTML += '<br><span style="color:var(--muted)">Siguiente ronda…</span>';
  }
  // Si el rival se va entre rondas
  Net.onOpponentLeft = ()=>{ toast('El rival abandonó la serie.'); };
}

// Fin de partida online: en vez de "revancha", ambos pueden volver a la sala.
// El host inicia la próxima partida desde el lobby; cualquiera de los dos
// arranca apenas el host sube el nuevo tablero (siguen escuchando el start).
function setupOnlineEnd(){
  const roomBtn = $('btn-to-room');
  roomBtn.style.display='block'; roomBtn.disabled=false;

  Net.onStart = (boardStr)=>{
    Net.stopListenStart();
    roomBtn.style.display='none';
    startOnlineGame(boardStr, Net.role);
  };
  Net.listenStart();

  roomBtn.onclick = ()=>{ returnToRoom(); };

  // Si el rival se va en la pantalla de fin, avisar y ocultar la opción
  Net.onOpponentLeft = ()=>{
    roomBtn.style.display='none';
    toast('El rival abandonó la sala.');
  };
}

// Vuelve al lobby de la sala (sin cerrarla) para jugar otra partida
function returnToRoom(){
  G.phase='idle';
  $('lobby-created').style.display='flex'; $('lobby-join').style.display='none';
  $('code-out').textContent = App.roomCode || '····';
  $('btn-demo-start').style.display='none';
  const isHost = Net.role==='host';
  $('mode-select').style.display = isHost ? 'flex' : 'none';
  $('btn-share').style.display   = isHost ? 'block' : 'none';
  onBothReady({ role: Net.role, oppName: App.oppName || 'Rival' });
  show('lobby');
}
function endGame(){
  G.running=false; G.phase='gameover';
  const youHp=Math.max(0,G.you.hp), oppHp=Math.max(0,G.opp.hp);
  const youWon = youHp>oppHp;
  const nextBtn=$('btn-tourney-next'), againBtn=$('btn-again');
  nextBtn.style.display='none'; againBtn.style.display='block';
  const roomBtn=$('btn-to-room'); roomBtn.style.display='none';
  const campBtn=$('btn-camp-next'); campBtn.style.display='none';
  const rt=$('result-title'); rt.classList.remove('is-win','is-lose');

  // --- Torneo online x4: el resultado va al bracket, no a la pantalla clásica ---
  if(OT.active && OT.inMatch){ OT.onMyMatchEnd(youHp, oppHp); return; }

  // --- Fin de partida ONLINE ---
  if(G.online){
    const isTie = (youHp===oppHp);
    // Mejor de 5: actualizar marcador (los empates no suman a nadie)
    if(App.matchMode==='bo5' && !isTie){
      if(youHp>oppHp) App.scoreYou++; else App.scoreOpp++;
    }
    const matchOver = App.matchMode!=='bo5' ||
                      App.scoreYou>=BO5_TARGET || App.scoreOpp>=BO5_TARGET;

    $('result-eyebrow').textContent = (App.matchMode==='bo5')
      ? `Mejor de 5 · ${App.scoreYou}–${App.scoreOpp}` : 'Final';

    if(isTie)              $('result-title').textContent='Empate';
    else if(youHp>oppHp)   $('result-title').textContent= matchOver ? 'Ganaste' : 'Ganaste la ronda';
    else                   $('result-title').textContent= matchOver ? 'Perdiste' : 'Perdiste la ronda';

    if(App.matchMode==='bo5'){
      $('result-score').innerHTML=`Rondas: <b>${App.scoreYou}</b> – <b>${App.scoreOpp}</b><br><span style="color:var(--muted)">${youHp} HP vs ${oppHp} HP</span>`;
    } else {
      $('result-score').innerHTML=`<b>${youHp}</b> HP vs <b>${oppHp}</b> HP`;
    }
    againBtn.style.display='none';

    if(matchOver){
      let won = isTie ? null : (youHp>oppHp);
      if(App.matchMode==='bo5'){
        const champ = App.scoreYou>App.scoreOpp;
        $('result-title').textContent = champ ? '🏆 Ganaste la serie' : 'Perdiste la serie';
        won = champ;
      }
      if(won===true)  rt.classList.add('is-win');
      if(won===false) rt.classList.add('is-lose');
      App.scoreYou=0; App.scoreOpp=0;   // reset para futuras series
      setupOnlineEnd();
    } else {
      // Quedan rondas: continuar la serie automáticamente (mismo flujo de revancha)
      setupNextRound();
    }
    show('result');
    return;
  }

  // --- Fin de partida en CAMPAÑA (offline): se ve como un final normal, pero
  //     al ganar se cachea el progreso y "Continuar ▸" avanza al próximo nodo.
  if(Campaign.active){
    $('result-eyebrow').textContent='Final';
    $('result-score').innerHTML=`<b>${youHp}</b> HP vs <b>${oppHp}</b> HP`;
    if(youWon){
      $('result-title').textContent='Ganaste';
      rt.classList.add('is-win');
      Campaign.completeCurrent();      // cachea el avance YA (aunque cierre la app)
      againBtn.style.display='none';
      campBtn.style.display='block';
    } else {
      $('result-title').textContent = (youHp===oppHp) ? 'Empate' : 'Perdiste';
      if(youHp<oppHp) rt.classList.add('is-lose');
      againBtn.textContent='Reintentar';   // vuelve a jugar el mismo nodo
    }
    show('result');
    return;
  }

  if(Tourney.active){
    const r=TOURNEY_ROSTER[Tourney.index];
    const isLast = Tourney.index >= TOURNEY_ROSTER.length-1;
    if(youWon && isLast){
      Tourney._carryHp = youHp;
      $('result-eyebrow').textContent='🏆 Torneo';
      $('result-title').textContent='¡Campeón!';
      $('result-score').innerHTML=`Venciste a <b>${r.name}</b> y ganaste el torneo con <b>${youHp}</b> HP restante.`;
      againBtn.style.display='none';
      Tourney._beaten = Tourney.index;   // venció a todos
      Tourney.active=false;
      Tourney._carryHp=null;             // reset para el próximo torneo
    } else if(youWon){
      Tourney._carryHp = youHp;          // conserva la vida para la próxima ronda
      Tourney._beaten = Tourney.index;   // último vencido
      $('result-eyebrow').textContent=`Rival ${Tourney.index+1}/${TOURNEY_ROSTER.length}`;
      $('result-title').textContent=`Venciste a ${r.name}`;
      $('result-score').innerHTML=`Te quedan <b>${youHp}</b> HP. Próximo rival con más vida y más astuto.`;
      againBtn.style.display='none';
      nextBtn.style.display='block';
    } else {
      $('result-eyebrow').textContent='Torneo';
      $('result-title').textContent='Eliminado';
      $('result-score').innerHTML=`Llegaste hasta el rival <b>${Tourney.index+1}/${TOURNEY_ROSTER.length}</b> (${r.name}).`;
      againBtn.textContent='Reintentar rival';
      Tourney.active=true; // permitir reintentar el mismo (conserva _carryHp de la ronda anterior)
    }
    show('result');
    return;
  }

  $('result-eyebrow').textContent='Final';
  if(youHp===oppHp)      $('result-title').textContent='Empate';
  else if(youHp>oppHp)   $('result-title').textContent='Ganaste';
  else                   $('result-title').textContent='Perdiste';
  $('result-score').innerHTML=`<b>${youHp}</b> HP vs <b>${oppHp}</b> HP`;
  show('result');
}

