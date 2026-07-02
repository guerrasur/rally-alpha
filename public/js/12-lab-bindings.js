function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function beginGame(){
  updateHud(); show('game');
  if(!beginGame._seen){ beginGame._seen=true; $('howto').classList.add('is-show'); }
  else startGame();
}

// Aplica el color cosmético del rival actual (o lo limpia fuera del torneo)
function applyOppCosmetic(){
  const root=document.documentElement;
  if(Campaign.active && Campaign.cur() && Campaign.cur().type==='match'){
    const o = Campaign.cur().opp || {};
    if(o.accent) root.style.setProperty('--opp-accent', o.accent);
    else root.style.removeProperty('--opp-accent');
    App.oppName = o.name || '???';
    return;
  }
  if(Tourney.active){
    const r=TOURNEY_ROSTER[Tourney.index];
    root.style.setProperty('--opp-accent', r.accent);
    App.oppName=r.name;
  } else {
    root.style.removeProperty('--opp-accent');
    if(!OT.active) root.style.removeProperty('--you-accent');
  }
}

// Pantalla "Mortal Kombat": tu nombre vs la lista de rivales apilados.
// Rey Julian arriba en dorado; vencidos tachados en rojo; el actual resaltado.
function showTourneyBracket(onGo){
  const youHp = (Tourney._carryHp!=null) ? Tourney._carryHp : CFG.maxHp;
  $('bracket-you-name').textContent = App.playerName;
  $('bracket-you-hp').textContent = youHp+' HP';
  $('bracket-title').textContent = (Tourney.index===0) ? '¡Comienza el torneo!' : 'Próximo combate';

  const wrap = $('bracket-rivals'); wrap.innerHTML='';
  const order = TOURNEY_ROSTER.map((r,i)=>i).reverse();  // Rey Julian (jefe) arriba
  order.forEach(i=>{
    const r = TOURNEY_ROSTER[i];
    const row = document.createElement('div');
    row.className = 'fighter--rival';
    if(r.trait==='luck') row.classList.add('is-king');          // Rey Julian dorado
    if(i < Tourney.index) row.classList.add('is-beaten');       // ya vencido
    if(i === Tourney.index) row.classList.add('is-current');    // rival actual
    const hp = tourneyHpFor(i);
    row.innerHTML = `<span class="r-name">${r.emoji?r.emoji+' ':''}${r.name}</span><span class="r-hp">${hp} HP</span>`;
    wrap.appendChild(row);
  });

  $('bracket-go').onclick = ()=>{ if(onGo) onGo(); };
  show('bracket');
}

function startTournament(){
  Tourney.active=true; Tourney.index=0;
  Tourney._carryHp=null; Tourney._beaten=-1; Tourney._duelCount=0;
  $('btn-again').textContent='Reintentar rival';
  applyOppCosmetic();
  showTourneyBracket(()=>{ show('game'); startGame(); });
}
function nextTourneyOpponent(){
  Tourney.index++;
  if(Tourney.index>=TOURNEY_ROSTER.length){ Tourney.active=false; show('home'); return; }
  applyOppCosmetic();
  showTourneyBracket(()=>{ show('game'); startGame(); });
}

$('btn-howto-ok').addEventListener('click', ()=>{ $('howto').classList.remove('is-show'); startGame(); });
$('btn-tournament').addEventListener('click', ()=>{ readName(); App.online=false; startTournament(); });
$('btn-tourney-next').addEventListener('click', ()=>{ nextTourneyOpponent(); });
// Etapa 2: cuando ambos están en la sala. El HOST ve "Iniciar partida"
// (genera y sube el board). El GUEST espera a recibir el board.
function onBothReady(info){
  Sound.duelStart && Sound.duelStart();
  haptic([15,30,15]);
  $('wait-text').textContent = '✓ Rival conectado: ' + info.oppName;

  // Ambos escuchan el arranque (cuando aparece el board en Firebase)
  Net.onStart = (boardStr)=>{
    Net.stopListenStart();
    startOnlineGame(boardStr, Net.role);
  };
  Net.listenStart();

  if(info.role === 'host'){
    let go = $('btn-online-start');
    if(!go){
      go = document.createElement('button');
      go.id = 'btn-online-start';
      go.className = 'btn btn--primary';
      go.textContent = '▸ Iniciar partida';
      go.style.marginBottom = '11px';
      const actions = $('lobby-created').querySelector('.actions');
      actions.insertBefore(go, actions.firstChild);
      go.addEventListener('click', async ()=>{
        go.disabled = true; go.textContent = 'Iniciando…';
        await Net.resetForRematch();        // limpia datos de una partida previa
        buildBoard();                       // el host genera el tablero
        await Net.pushStart(serializeBoard()); // lo sube; dispara onStart en ambos
      });
    }
    go.disabled = false; go.textContent = '▸ Iniciar partida';
    go.style.display = 'block';
  } else {
    // Guest: sin botón, queda esperando el board del host
    $('wait-text').textContent = '✓ Conectado a ' + info.oppName + '. Esperando inicio…';
  }
}

async function startCreateRoom(){
  readName(); App.online=!DEMO; App.isHost=true;
  App.scoreYou=0; App.scoreOpp=0;   // nueva serie
  $('lobby-created').style.display='flex'; $('lobby-join').style.display='none'; show('lobby');
  $('mode-select').style.display='flex'; $('btn-share').style.display='block';
  $('ot-box').style.display='none'; setModeUI(App.matchMode==='bo5'?'mode-bo5':'mode-single');
  const goBtn = $('btn-online-start'); if(goBtn) goBtn.style.display='none';
  $('wait-text').textContent='Esperando rival…';
  $('code-out').textContent='····';
  Net.onReady = onBothReady;
  try {
    const code=await Net.createRoom(); App.roomCode=code; $('code-out').textContent=code;
  } catch(e){
    console.error(e); toast('No se pudo crear la sala. Revisá tu conexión.');
    $('code-out').textContent='––––'; return;
  }
  if(DEMO){ $('btn-demo-start').style.display='block'; $('wait-text').textContent='Modo práctica disponible'; }
}
$('btn-create').addEventListener('click', ()=>{ exitSpecialMode(); startCreateRoom(); });
$('btn-join').addEventListener('click', ()=>{ readName(); $('join-name').value=App.playerName==='Jugador'?'':App.playerName; $('lobby-created').style.display='none'; $('lobby-join').style.display='flex'; $('code-in').value=''; show('lobby'); setTimeout(()=>$('code-in').focus(),200); });
function setModeUI(id){
  ['mode-single','mode-bo5','mode-t4'].forEach(m=>$(m).classList.toggle('is-on', m===id));
}
$('mode-single').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='single'; setModeUI('mode-single');
});
$('mode-bo5').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='bo5'; setModeUI('mode-bo5');
});
$('mode-t4').addEventListener('click', async ()=>{
  if(OT.active) return;
  const ok=await OT.enableTourney();
  if(ok) setModeUI('mode-t4');
});
$('btn-ot-start').addEventListener('click', ()=>OT.start());
$('btn-ot-room').addEventListener('click', ()=>OT.backToLobby());
$('btn-ot-exit').addEventListener('click', ()=>OT.leaveTournament());
$('btn-spec-back').addEventListener('click', ()=>{ OT.stopSpec(); show('othub'); OT.renderHub(); });
$('btn-offline').addEventListener('click', ()=>{ readName(); updateCampaignBtn(); show('offline'); });

// ---- Campaña: botón de entrada + menú de confirmación ----
// Si hay progreso cacheado, el botón pasa a "Continuar campaña" y al tocarlo
// retoma automáticamente en el nodo guardado (sin volver a confirmar).
function updateCampaignBtn(){
  Campaign.load();
  $('btn-campaign').textContent = Campaign.hasProgress() ? '▶ Continuar campaña' : 'Campaña';
}
$('btn-campaign').addEventListener('click', ()=>{
  readName(); exitSpecialMode(); App.online=false; Tourney.active=false;
  if(Campaign.hasProgress()){ Campaign.resume(); return; }
  // Primera vez: menú de confirmación con el nombre del jugador
  $('camp-title').innerHTML = `¿Comenzar campaña como <b>${escapeHtml(App.playerName)}</b>?`;
  $('camp-box').classList.remove('is-fading');
  $('camp-overlay').hidden = false;
});
$('camp-no').addEventListener('click', ()=>{ $('camp-overlay').hidden = true; });
$('camp-yes').addEventListener('click', ()=>{
  // Desvanecer el menú en 3 segundos dejando solo el fondo plano…
  $('camp-box').classList.add('is-fading');
  setTimeout(()=>{
    // …y de pronto, arranca la partida (nodo 0: como una partida rápida normal)
    $('camp-overlay').hidden = true;
    Campaign.begin();
  }, 3600);   // 3s de fade + pausa breve en fondo plano
});
$('btn-camp-next').addEventListener('click', ()=>{ Campaign.enter(Campaign.node); });
$('btn-offline-back').addEventListener('click', ()=>{ show('home'); });
$('btn-quick').addEventListener('click', ()=>{ readName(); Tourney.active=false; applyOppCosmetic(); App.online=false; App.oppName='Cachito'; beginGame(); });
$('btn-demo-start').addEventListener('click', ()=>{ Tourney.active=false; applyOppCosmetic(); App.online=false; App.oppName='Cachito'; beginGame(); });
$('btn-join-go').addEventListener('click', async ()=>{
  const jn=$('join-name').value.trim();
  if(jn) $('name-input').value=jn;
  readName();
  const code=$('code-in').value.trim().toUpperCase();
  if(code.length!==4){ toast('El código tiene 4 caracteres.'); return; }
  if(DEMO){ App.online=false; App.oppName='Cachito'; App.roomCode=code; toast('Modo práctica: jugás contra la CPU.'); beginGame(); return; }

  App.online=true; App.isHost=false; App.roomCode=code;
  App.scoreYou=0; App.scoreOpp=0;   // nueva serie
  const goBtn=$('btn-join-go'); goBtn.disabled=true; goBtn.textContent='Conectando…';
  Net.onReady = onBothReady;
  try {
    const res = await Net.joinRoom(code);
    if(!res.ok){
      const msg = res.reason==='no-existe' ? 'Esa sala no existe.' :
                  res.reason==='llena'     ? 'La sala ya está llena.' :
                  'No se pudo unir a la sala.';
      toast(msg); goBtn.disabled=false; goBtn.textContent='Entrar'; return;
    }
    // Unido OK: pasar a la vista de sala con el aviso de conexión
    goBtn.disabled=false; goBtn.textContent='Entrar';
    if(res.tourney){ OT.showLobby(); return; }
    $('lobby-join').style.display='none'; $('lobby-created').style.display='flex';
    $('code-out').textContent=code;
    $('btn-demo-start').style.display='none';
    $('mode-select').style.display='none';   // el guest no elige modo
    $('btn-share').style.display='none';
    $('ot-box').style.display='none';
  } catch(e){
    console.error(e); toast('Error de conexión.'); goBtn.disabled=false; goBtn.textContent='Entrar';
  }
});
$('btn-lobby-back').addEventListener('click', ()=>{ if(OT.active){ OT.leaveTournament(); return; } Net.leave(); show('home'); });
$('btn-join-back').addEventListener('click', ()=>show('home'));
$('code-in').addEventListener('input', e=>{ e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
$('btn-leave').addEventListener('click', ()=>{ G.running=false; G.phase='idle'; Chat.unmount(); if(G.duel.raf) cancelAnimationFrame(G.duel.raf); if(G.duel.cpuTimer){ clearTimeout(G.duel.cpuTimer); G.duel.cpuTimer=null; } if(OT.active){ OT.leaveTournament(); return; } Tourney.active=false; Campaign.exitToMenu(); applyOppCosmetic(); $('btn-again').textContent='Revancha'; $('btn-again').style.display='block'; Net.leave(); show('home'); });
$('btn-mute').addEventListener('click', ()=>{ App.muted=!App.muted; $('btn-mute').textContent=App.muted?'♪ off':'♪ on'; });
$('btn-again').addEventListener('click', ()=>{ show('game'); startGame(); });
$('btn-home').addEventListener('click', ()=>{ Chat.unmount(); Tourney.active=false; Campaign.exitToMenu(); applyOppCosmetic(); $('btn-again').textContent='Revancha'; $('btn-again').style.display='block'; Net.leave(); show('home'); });

// Chat en vivo (solo online): abrir/cerrar panel y enviar mensajes.
$('chat-toggle').addEventListener('click', ()=> Chat.toggle());
$('chat-form').addEventListener('submit', e=>{ e.preventDefault(); Chat.send(); });

// #15 — Compartir invitación: arma un link con ?sala=CODIGO y lo comparte/copia
$('btn-share').addEventListener('click', async ()=>{
  const code = App.roomCode;
  if(!code || code==='····' || code==='––––'){ toast('Esperá a que se genere el código.'); return; }
  const url = `${location.origin}${location.pathname}?sala=${code}`;
  const shareData = { title:'Rally', text:`Te invito a jugar Rally. Código: ${code}`, url };
  try {
    if(navigator.share){ await navigator.share(shareData); }
    else { await navigator.clipboard.writeText(url); toast('Link copiado al portapapeles ✓'); }
  } catch(e){
    // Cancelado o sin permiso: intentar copiar como respaldo
    try { await navigator.clipboard.writeText(url); toast('Link copiado ✓'); }
    catch(_){ toast('Tu link: '+url); }
  }
});

// #15 — Auto-unirse si la URL trae ?sala=CODIGO
(function autoJoinFromURL(){
  if(DEMO) return;
  const params = new URLSearchParams(location.search);
  const sala = (params.get('sala')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(sala.length!==4) return;
  // Prefill y llevar al lobby de unirse; el usuario confirma con su nombre
  show('home');
  setTimeout(()=>{
    $('lobby-created').style.display='none'; $('lobby-join').style.display='flex';
    $('code-in').value=sala;
    const cached=$('name-input').value||'';
    $('join-name').value = cached==='Jugador' ? '' : cached;
    show('lobby');
    toast('Invitación detectada · elegí tu nombre y entrá');
    setTimeout(()=>$('join-name').focus(), 250);
  }, 300);
})();

$('home-foot').textContent = DEMO ? 'Modo práctica activo. Conectá Firebase para jugar online con un amigo.' : 'Online activo · creá una sala y pasá el código.';
try {
  const savedName = localStorage.getItem('rally_name');
  if(savedName){ $('name-input').value = savedName; App.playerName = savedName; }
} catch(e){}

// ===== 🌙 Modo oscuro (claro por defecto, se guarda en caché) =====
function applyTheme(theme){
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', dark ? '#141416' : '#EAEAE7');
}
(function(){
  let saved = 'light';
  try { saved = localStorage.getItem('rally_theme') || 'light'; } catch(e){}
  applyTheme(saved);
  // Estado inicial de los controles superiores: visibles solo en el inicio.
  const tc = $('top-controls');
  if(tc) tc.classList.toggle('is-hidden', App.screen !== 'home');
  const ib = $('btn-info');
  if(ib) ib.classList.toggle('is-hidden', App.screen !== 'home');
})();
$('btn-theme').addEventListener('click', ()=>{
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('rally_theme', next); } catch(e){}
  haptic(8);
});

// Botón de usuario: reservado para un update futuro (stats/logros/perfil).
// Por ahora no hace nada al tocarlo.
$('btn-user').addEventListener('click', ()=>{ /* TODO: pantalla de usuario */ });

// Botón de información: explica los elementos y el duelo del juego.
$('btn-info').addEventListener('click', ()=>{
  $('info-ver').innerHTML = `Rally <b>${VERSION}</b> · alpha`;
  show('info');
});
$('btn-info-back').addEventListener('click', ()=> show('home'));

// ===== 🧪 Laboratorio (panel de balance) =====
// Parámetros editables: [clave, etiqueta, min, max, step, grupo]
const LAB_PARAMS = [
  ['maxHp','Vida máxima',10,300,5,'General'],
  ['regenInterval','Turnos para regenerar ítems',1,10,1,'General'],
  ['powerDmgValue','Valor buff daño (🗡️)',1,10,1,'Ítems'],
  ['powerDefValue','Valor buff defensa (◈)',1,10,1,'Ítems'],
  ['maxPowerDmg','Tope buff daño',1,20,1,'Ítems'],
  ['maxPowerDef','Tope buff defensa',1,20,1,'Ítems'],
  ['downDamage','Daño de trampa (×)',1,30,1,'Ítems'],
  ['powerDmgCount','Cantidad 🗡️ inicial',0,10,1,'Ítems'],
  ['powerDefCount','Cantidad ◈ inicial',0,10,1,'Ítems'],
  ['downCount','Cantidad × inicial',0,12,1,'Ítems'],
  ['perfectScore','Puntaje PERFECTO',10,40,1,'Duelo'],
  ['greenScore','Puntaje Verde',1,20,1,'Duelo'],
  ['yellowScore','Puntaje Amarillo',1,20,1,'Duelo'],
  ['orangeScore','Puntaje Naranja',1,20,1,'Duelo'],
  ['redBaseScore','Puntaje Rojo (base)',0,10,1,'Duelo'],
  ['duelCycleDuration','Velocidad aguja (seg/ciclo)',0.8,3,0.1,'Duelo'],
  ['duelMaxPasses','Pases máximos',2,8,1,'Duelo'],
];
const CFG_DEFAULTS = JSON.parse(JSON.stringify(CFG));  // copia original para restaurar

function buildLab(){
  const body = $('lab-body'); body.innerHTML='';
  let lastGroup='';
  LAB_PARAMS.forEach(([key,label,min,max,step,group])=>{
    if(group!==lastGroup){ const g=document.createElement('div'); g.className='lab-group'; g.textContent=group; body.appendChild(g); lastGroup=group; }
    const row=document.createElement('div'); row.className='lab-row';
    const top=document.createElement('div'); top.className='lab-row__top';
    const lab=document.createElement('span'); lab.className='lab-row__label'; lab.textContent=label;
    const val=document.createElement('span'); val.className='lab-row__val'; val.id='labval-'+key; val.textContent=CFG[key];
    top.appendChild(lab); top.appendChild(val);
    const inp=document.createElement('input'); inp.type='range'; inp.min=min; inp.max=max; inp.step=step; inp.value=CFG[key];
    inp.addEventListener('input',()=>{ const v=parseFloat(inp.value); CFG[key]=v; $('labval-'+key).textContent=v; });
    row.appendChild(top); row.appendChild(inp);
    body.appendChild(row);
  });
}
function openLab(){ buildLab(); show('lab'); }

// Acceso oculto: ?lab=1 en la URL, o 5 toques en la versión
(function(){
  const params=new URLSearchParams(location.search);
  if(params.get('lab')==='1') setTimeout(openLab, 400);
  let taps=0, tapT;
  $('version-tag').addEventListener('click',()=>{
    taps++; clearTimeout(tapT); tapT=setTimeout(()=>taps=0,1200);
    if(taps>=5){ taps=0; openLab(); }
  });
  // Acceso oculto al menú experimental: 7 toques en el logo "Rally" (o ?beta=1)
  if(params.get('beta')==='1') setTimeout(()=>show('experimental'), 400);
  let bt=0, btT;
  const logo=$('brand-logo');
  if(logo) logo.addEventListener('click',()=>{
    bt++; clearTimeout(btT); btT=setTimeout(()=>bt=0,1200);
    if(bt>=7){ bt=0; show('experimental'); }
  });
})();

// Modo Paredes: entra al modo y arranca una partida rápida offline contra la CPU.
$('btn-walls').addEventListener('click', ()=>{
  readName(); Tourney.active=false; applyOppCosmetic();
  App.online=false; App.oppName='Cachito';
  enterWallsMode();
  beginGame();
});
$('btn-exp-back').addEventListener('click', ()=>{ exitSpecialMode(); show('home'); });
// Sala online con paredes: activa el modo y abre el flujo normal de crear sala.
// El host generará el tablero con paredes y lo sincroniza (prefijo "W" en el board).
$('btn-walls-online').addEventListener('click', ()=>{ enterWallsMode(); startCreateRoom(); });

$('lab-back').addEventListener('click',()=>{ show(G.running ? 'game' : 'home'); });
$('lab-spawn-ring').addEventListener('click',()=>{
  if(!G.running || !G.board || !G.board.length){ toast('Iniciá una partida primero.'); return; }
  // Buscar una casilla vacía que no sea de ningún jugador
  const n=CFG.boardSize; let placed=false;
  for(let i=0;i<200 && !placed;i++){
    const x=Math.floor(Math.random()*n), y=Math.floor(Math.random()*n);
    const c=cellAt(x,y);
    const onPlayer=(G.you.x===x&&G.you.y===y)||(G.opp.x===x&&G.opp.y===y);
    if(c.type==='empty' && !onPlayer){ c.type='ring'; G.ringSpawned=true; placed=true; }
  }
  if(placed){
    renderBoard();
    if(G.online && Net.role==='host' && Net.pushBoard) Net.pushBoard(serializeBoard());
    toast('{ring} Anillo colocado. Volvé a la partida.');
  } else { toast('No hay lugar libre en el tablero.'); }
});
$('lab-reset').addEventListener('click',()=>{
  Object.keys(CFG_DEFAULTS).forEach(k=>CFG[k]=CFG_DEFAULTS[k]);
  buildLab(); toast('Valores restaurados ✓');
});
$('lab-export').addEventListener('click',()=>{
  const out={}; LAB_PARAMS.forEach(([k])=>out[k]=CFG[k]);
  $('lab-json').value = JSON.stringify(out,null,2);
  try { navigator.clipboard.writeText($('lab-json').value); toast('JSON copiado ✓'); }
  catch(e){ toast('JSON listo abajo para copiar'); }
});
$('lab-import').addEventListener('click',()=>{
  try {
    const data=JSON.parse($('lab-json').value);
    let n=0;
    LAB_PARAMS.forEach(([k])=>{ if(typeof data[k]==='number'){ CFG[k]=data[k]; n++; } });
    buildLab(); toast(`Importados ${n} valores ✓`);
  } catch(e){ toast('JSON inválido. Revisá el formato.'); }
});
