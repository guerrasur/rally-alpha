function startGame(){
  G.online=false; G.flip=false;
  Chat.unmount();   // sin chat en offline/local
  applyOppCosmetic();
  buildBoard(); const n=CFG.boardSize;
  const oppHp = Campaign.active ? (Campaign.matchOpt('hp') || CFG.maxHp)
              : Tourney.active  ? tourneyHpFor(Tourney.index) : CFG.maxHp;
  // En torneo, el jugador conserva la vida entre rondas (salvo al empezar/reintentar)
  const youHp = Campaign.active ? ((Campaign.cur() && Campaign.cur().youHp) || CFG.maxHp)
              : (Tourney.active && Tourney._carryHp!=null) ? Tourney._carryHp : CFG.maxHp;
  G.you = {x:n-1,y:n-1,hp:youHp,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
  G.opp = {x:0,y:0,hp:oppHp,maxHp:oppHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
  G.turnCount = 0; G.justDueled = false; G.running = true; G.ringSpawned=false; G.you.ringDrip=0; G.opp.ringDrip=0;
  resolveSkins();   // easter egg Messi (offline: solo aplica tu propia skin)
  updateHud(); renderBoard(); startChoosePhase();
}

// Etapa 2: arranque sincronizado. Ambos clientes comparten el mismo board.
// role: 'host' (ficha en 6,6 canónico) o 'guest' (ficha en 0,0, vista espejada).
function startOnlineGame(boardStr, role){
  G.online = true;
  G.flip = (role === 'guest');
  deserializeBoard(boardStr);        // esto define CFG.boardSize (7 normal, 9 paredes)
  const n = CFG.boardSize;           // leer DESPUÉS de deserializar
  document.documentElement.style.removeProperty('--opp-accent'); // rival neutro online
  if(role === 'host'){
    G.you = {x:n-1,y:n-1,hp:CFG.maxHp,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
    G.opp = {x:0,  y:0,  hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
  } else {
    G.you = {x:0,  y:0,  hp:CFG.maxHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
    G.opp = {x:n-1,y:n-1,hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
  }
  G.turnCount = 0; G.justDueled = false; G.running = true; G.ringSpawned=false; G.you.ringDrip=0; G.opp.ringDrip=0;
  resolveSkins();   // easter egg Messi: define skins/nombre según ambos jugadores
  show('game');
  updateHud(); renderBoard();

  // Listener: cuando el host regenera items, el guest recibe el board nuevo.
  // Actualiza solo los tipos de celda, nunca las posiciones de jugadores.
  Net.onBoardUpdate = (boardStr)=>{
    // Soporta formato con paredes ("W<size>|<paredes>|<celdas>"): solo cambian
    // los ítems, así que extraemos la parte de celdas. Las paredes no varían.
    let cells = boardStr;
    if(typeof boardStr==='string' && boardStr[0]==='W'){
      const i2 = boardStr.indexOf('~', boardStr.indexOf('~')+1);
      cells = boardStr.slice(i2+1);
    }
    if(cells.length !== CFG.boardSize*CFG.boardSize) return;
    for(let i=0;i<G.board.length;i++){
      G.board[i].type = CODE_CELL[cells[i]] || 'empty';
    }
    renderBoard();
  };
  Net.listenBoard();

  // Vigilar abandono/desconexión del rival, con gracia de reconexión (#5)
  Net.onOpponentLeft = onOpponentLeft;
  Net.onOpponentWaiting = ()=>{ toast('Rival desconectado… esperando reconexión'); setMsg('⚠️ Rival desconectado — esperando…', true); };
  Net.onOpponentBack = ()=>{ toast('Rival reconectado ✓'); };
  Net.startPresence();

  // Chat en vivo (solo online): monta el panel y escucha mensajes.
  Chat.mount();

  // Etapa 3A: arrancamos la fase de elección con movimientos sincronizados.
  startChoosePhase();
}

// El rival se desconectó o salió → victoria por abandono.
const ABANDON_MSGS = [
  'Al parecer sos intimidante',
  'Te tuvieron miedo',
  'Lo llamaron a comer',
];
function onOpponentLeft(){
  if(!G.online || G.phase==='gameover') return;
  G.running=false; G.phase='gameover'; G.online=false;
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  $('duel-overlay').classList.remove('is-show');
  if(OT.active && OT.inMatch){
    toast('Tu rival abandonó — pasás de ronda');
    OT.onMyMatchEnd(Math.max(1, G.you.hp), 0);
    return;
  }
  const msg = ABANDON_MSGS[Math.floor(Math.random()*ABANDON_MSGS.length)];
  $('result-eyebrow').textContent='Final';
  $('result-title').textContent='VICTORIA';
  $('result-title').classList.remove('is-lose'); $('result-title').classList.add('is-win');
  $('result-score').innerHTML=`<span style="color:var(--muted)">(por abandono…)</span><br><br>${msg}`;
  $('btn-tourney-next').style.display='none';
  $('btn-to-room').style.display='none';
  $('btn-again').style.display='none';   // no hay revancha en abandono online
  show('result');
}
function startChoosePhase(){
  G.phase='choose'; G.yourMove=null; G.oppMove=null;
  if(OT.active && OT.inMatch && OT.master) OT.pushSpec();
  if(G.justDueled && areAdjacentOrSame(G.you, G.opp)){
    setMsg('Tregua 🛡️ — elegí a dónde moverte', true);
  } else {
    setMsg('Elegí un casillero contiguo para moverte', true);
  }
  renderBoard();
  if(G.online){
    G._oppMovedThisTurn = false;
    // Empezar a escuchar los movimientos de este turno
    Net.onMovesReady = onOnlineMovesReady;
    Net.onOppMoved = ()=>{
      G._oppMovedThisTurn = true;
      // Si todavía no elegí, mostrar que el rival ya está listo
      if(G.phase==='choose'){
        setMsg('El rival ya eligió — te toca mover', true);
      }
    };
    Net.listenMoves(G.turnCount);
  }
}

function onPlayerMove(x, y){
  if(G.phase!=='choose') return;
  G.yourMove={x,y};
  if(G.online){
    // Online: subir mi movimiento y esperar al rival
    G.phase='waiting-opp';
    setMsg('Esperando al rival…', true);
    renderBoard();
    Net.pushMove(G.turnCount, x, y).catch(e=>{ console.error(e); toast('Error al enviar movimiento.'); });
    return;
  }
  // Offline: la CPU responde y se resuelve
  G.oppMove=cpuDecideMove();
  resolveMoves();
}

// Online: llegaron ambos movimientos. Mapear según mi rol y resolver.
function onOnlineMovesReady(moves){
  if(G.phase!=='waiting-opp' && G.phase!=='choose') return;
  const mine  = (Net.role==='host') ? moves.host  : moves.guest;
  const other = (Net.role==='host') ? moves.guest : moves.host;
  G.yourMove = { x:mine.x,  y:mine.y  };
  G.oppMove  = { x:other.x, y:other.y };
  resolveMoves();
}

function cpuDecideMove(){
  let reachable = getReachable(G.opp.x, G.opp.y);
  const n = CFG.boardSize;

  // Rasgo de Marlene: a veces puede moverse 2 casilleros en cualquier dirección
  if(currentTrait()==='doubleStep' && Math.random()<0.3){
    const far = [];
    for(let dy=-2; dy<=2; dy++) for(let dx=-2; dx<=2; dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==2) continue; // solo el anillo de distancia 2
      const nx=G.opp.x+dx, ny=G.opp.y+dy;
      if(nx>=0&&nx<n&&ny>=0&&ny<n) far.push({x:nx,y:ny});
    }
    reachable = reachable.concat(far);
  }

  // Skill 0→1 (0.35 fijo en práctica). Más skill = menos ruido y mejor planeo.
  const skill = currentCpuSkill();
  const noise = 3.0 * (1 - skill) + 0.15;

  // ¿Está "encerrada"? = casi todas las casillas a las que puede ir son trampas.
  const nonTrap = reachable.filter(p => cellAt(p.x,p.y).type !== 'down');
  const boxedIn = nonTrap.length === 0;             // solo puede pisar cruces
  const almostBoxed = nonTrap.length <= 1;          // casi sin salida

  // ¿Necesita un buff con urgencia? (HP bajo → quiere defensa; desventaja → daño)
  const lowHp = G.opp.hp <= CFG.cpuDesperateHpMin;       // p.ej. < 30
  const losing = G.opp.hp < G.you.hp;

  // Helper: ¿esta casilla da acceso INMEDIATO a un power-up que la CPU necesita?
  function leadsToNeededBuff(p){
    const fut = getReachable(p.x, p.y);
    return fut.some(fp=>{
      const t = cellAt(fp.x,fp.y).type;
      if(t==='power_def' && (lowHp || losing)) return true;   // defensa si está mal
      if(t==='power_dmg' && losing) return true;              // daño si va perdiendo
      if(t==='ring' && (lowHp || losing)) return true;        // anillo si está lastimada
      return false;
    });
  }

  const scored = reachable.map(p => {
    const cell = cellAt(p.x, p.y);
    let score = 0;

    if(cell.type === 'power_dmg') score += 6;
    if(cell.type === 'power_def') score += 5;
    if(cell.type === 'ring'){
      // El anillo cura: siempre valioso, y MUCHO más si la CPU está lastimada
      // (con poca vida dispara la cura grande). Lo prioriza sobre otros ítems.
      const missing = CFG.maxHp - G.opp.hp;               // cuánta vida le falta
      score += 7 + (missing / CFG.maxHp) * 8;             // ~7 sana, hasta ~15 muy herida
      if(losing) score += 2;                              // extra si va perdiendo
    }
    if(cell.type === 'empty')     score += 1;   // base: moverse a vacío es bueno

    if(cell.type === 'down'){
      // Regla central: una trampa es la PEOR opción por defecto (−10 HP real).
      score -= 14;

      // Excepción 1: SOLO si está totalmente encerrada (no hay casilla sin trampa),
      // cruzar una cruz es inevitable; entre ellas, preferí la que deje salida.
      if(boxedIn){
        score += 13;
        const fut = getReachable(p.x, p.y);
        const escape = fut.filter(fp => cellAt(fp.x,fp.y).type !== 'down').length;
        score += escape * 0.8;
      }
      // Excepción 2: la trampa es atajo a un buff que necesita desesperadamente.
      // El neto queda en −5 (−14+9): solo la tomará si el resto es aún peor,
      // es decir, si no hay un camino sin trampa igual de bueno.
      else if(leadsToNeededBuff(p)){
        score += 9;
      }
      // En cualquier otro caso, la cruz queda muy negativa → la evita.
    }

    // Acercarse / alejarse del rival según ventaja (solo casillas no-trampa)
    if(cell.type !== 'down'){
      const dist = Math.max(Math.abs(p.x - G.you.x), Math.abs(p.y - G.you.y));
      if(dist <= 2 && G.opp.hp > G.you.hp) score += 1.5 + skill * 2;     // presiona
      else if(dist <= 2 && G.opp.hp < G.you.hp) score -= 2 + skill * 2;  // evita

      // Rivales hábiles valoran acercarse a power-ups alcanzables el próximo turno
      if(skill > 0.4){
        const fut = getReachable(p.x, p.y);
        const powerNear = fut.filter(fp=>{
          const t = cellAt(fp.x,fp.y).type;
          return t==='power_dmg' || t==='power_def' || t==='ring';
        }).length;
        score += powerNear * skill * 1.2;
      }
    }

    // Anti-vaivén: penalizar volver a una casilla reciente. Cuanto más reciente,
    // mayor la penalización. Además, castigar EXTRA cada repetición para romper
    // ciclos (ping-pong entre dos casillas).
    if(G.opp.history && G.opp.history.length){
      const key = `${p.x},${p.y}`;
      let visits = 0, lastIdx = -1;
      for(let h=0; h<G.opp.history.length; h++){
        if(G.opp.history[h]===key){ visits++; lastIdx = h; }
      }
      if(lastIdx !== -1){
        const recency = G.opp.history.length - lastIdx; // 1 = la más reciente
        score -= 6 / recency;          // penalización por reciente
        score -= (visits - 1) * 3;     // extra por cada repetición → castiga ciclos
      }
    }

    score += Math.random() * noise;
    return { ...p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Salvaguarda dura anti-trabazón (#17): si la mejor opción es una casilla ya
  // visitada 2+ veces en el historial reciente, y existe alguna casilla NO trampa
  // que NO esté en el historial, forzar ir a esa casilla fresca. Rompe el ciclo
  // aunque el score la favoreciera.
  if(!G.online && G.opp.history && G.opp.history.length>=4){
    const best = scored[0];
    const bestVisits = G.opp.history.filter(h=>h===`${best.x},${best.y}`).length;
    if(bestVisits>=2){
      const fresh = scored.filter(p=>{
        const key = `${p.x},${p.y}`;
        return cellAt(p.x,p.y).type!=='down' && !G.opp.history.includes(key);
      });
      if(fresh.length) return { x: fresh[0].x, y: fresh[0].y };
    }
  }

  return { x: scored[0].x, y: scored[0].y };
}

function resolveMoves(){
  G.phase='moving'; setMsg('Moviendo…');
  G.you.prevX=G.you.x; G.you.prevY=G.you.y; G.opp.prevX=G.opp.x; G.opp.prevY=G.opp.y;
  // Historial de las últimas casillas de la CPU (solo offline; evita vaivén)
  if(!G.online){
    if(!G.opp.history) G.opp.history=[];
    G.opp.history.push(`${G.opp.x},${G.opp.y}`);
    if(G.opp.history.length>6) G.opp.history.shift();
  }
  G.you.x=G.yourMove.x; G.you.y=G.yourMove.y; G.opp.x=G.oppMove.x; G.opp.y=G.oppMove.y;
  applySharedCellEffects();
  applyRingDrip(G.you); applyRingDrip(G.opp);
  // La tregua se cumple en cuanto ambos se mueven: quitar la burbuja YA,
  // antes de redibujar, para que no quede un instante en la casilla nueva.
  const wasTruce = G.justDueled;
  G.justDueled = false;
  Sound.step(); haptic(10); renderBoard(); updateHud();
  if(G.you.hp<=0 || G.opp.hp<=0){ setTimeout(()=>endGame(), 800); return; }
  G.turnCount++;

  // Regeneración de items: en online la decide SOLO el host y la sincroniza
  if(G.turnCount>0 && G.turnCount%CFG.regenInterval===0){
    if(!G.online){
      setTimeout(()=>{ regenerateItems(); renderBoard(); }, 300);
    } else if(Net.role==='host'){
      setTimeout(()=>{ regenerateItems(); renderBoard(); Net.pushBoard(serializeBoard()); }, 300);
    }
    // el guest recibe el board nuevo por el listener onBoardUpdate
  }

  setTimeout(()=>{
    if(wasTruce){
      // Este turno era la tregua post-duelo: no se dispara duelo aunque estén juntos
      startChoosePhase();
    } else if(areAdjacentOrSame(G.you, G.opp) && !wallSeparates(G.you, G.opp)){
      if(G.online){
        startDuelOnline();
      } else {
        startDuel();
      }
    } else {
      startChoosePhase();
    }
  }, 550);
}
// Aplica los efectos de casilla de ambos jugadores. Si los dos caen en la MISMA
// casilla con un buff, lo gana solo uno (sorteo determinista por turno, para que
// online ambos clientes coincidan). El otro no recibe nada de esa casilla.
function applySharedCellEffects(){
  const sameCell = (G.you.x===G.opp.x && G.you.y===G.opp.y);
  if(sameCell){
    const cell = cellAt(G.you.x, G.you.y);
    if(cell.type==='power_dmg' || cell.type==='power_def' || cell.type==='ring'){
      // Sorteo determinista: depende del turno y la posición (igual en ambos clientes)
      const seed = (G.turnCount*31 + G.you.x*7 + G.you.y*13) % 2;
      const youWins = (seed===0);
      const winner = youWins ? G.you : G.opp;
      applyCellEffect(winner);                 // solo uno recibe el ítem/anillo
      cell.type='empty';                       // la casilla queda vacía para el otro
      // (sin toast: el HUD ya refleja el buff; el aviso solo interrumpía el ritmo)
      return;
    }
    if(cell.type==='down'){
      // Trampa compartida: ambos la pisan (ambos reciben el daño)
      applyCellEffect(G.you);
      // la casilla ya se consumió; aplicar daño al otro manualmente
      G.opp.hp = Math.max(1, G.opp.hp - CFG.downDamage);
      return;
    }
    return; // casilla vacía
  }
  // Casillas distintas: cada uno la suya, normal
  applyCellEffect(G.you); applyCellEffect(G.opp);
}

function applyCellEffect(player){
  const cell = cellAt(player.x, player.y);
  if(cell.type==='power_dmg'){ player.buffs.dmg+=CFG.powerDmgValue; Sound.pickupAtk(); cell.type='empty'; }
  else if(cell.type==='power_def'){ player.buffs.def+=CFG.powerDefValue; Sound.pickupDef(); cell.type='empty'; }
  else if(cell.type==='down'){
    // Las trampas nunca matan: dejan al jugador en 1 HP como mínimo.
    player.hp = Math.max(1, player.hp - CFG.downDamage);
    Sound.trap(); cell.type='empty';
  }
  else if(cell.type==='ring'){
    const other = (player===G.you) ? G.opp : G.you;
    const diff = other.hp - player.hp;       // cuánto más vida tiene el rival
    cell.type='empty';
    Sound.pickupDef && Sound.pickupDef();
    if(diff >= CFG.ringHealDiff && player.hp < CFG.ringHealUnder){
      // Cura grande inmediata
      player.hp = Math.min(CFG.maxHp, player.hp + CFG.ringBigHeal);
      const who = (player===G.you)?App.playerName:App.oppName;
      toast(`{ring} ${who} +${CFG.ringBigHeal} HP`);
    } else {
      // Cura goteo: 5 HP por ronda durante 5 rondas (incluida esta)
      player.ringDrip = CFG.ringDripRounds;
      const who = (player===G.you)?App.playerName:App.oppName;
      toast(`{ring} ${who} +${CFG.ringDripHeal} HP x${CFG.ringDripRounds}`);
    }
  }
}

// Aplica el goteo de curación del anillo (llamado cada ronda/turno)
function applyRingDrip(player){
  if(player.ringDrip && player.ringDrip>0){
    player.hp = Math.min(CFG.maxHp, player.hp + CFG.ringDripHeal);
    player.ringDrip--;
  }
}

function ejectPlayers(){
  const ejectPlayer = (player, other)=>{
    const dist = CFG.ejectMinDist + Math.floor(Math.random()*(CFG.ejectMaxDist-CFG.ejectMinDist+1));
    let vx = player.x-other.x, vy = player.y-other.y;
    if(vx===0&&vy===0){ vx=1; vy=0; }
    for(let i=0;i<dist;i++){
      const reachable = getReachable(player.x, player.y);
      if(reachable.length===0) break;
      const scored = reachable.map(p=>{
        const newDist = Math.sqrt(Math.pow(p.x-other.x,2)+Math.pow(p.y-other.y,2));
        const dx=p.x-player.x, dy=p.y-player.y;
        const alignment = (dx*vx+dy*vy)/(Math.sqrt(dx*dx+dy*dy)*Math.sqrt(vx*vx+vy*vy)+0.01);
        let score = newDist + alignment*2;
        if(areAdjacentOrSame(p,other)) score-=10;
        score += Math.random()*1.5; return {...p, score};
      });
      scored.sort((a,b)=>b.score-a.score); player.x=scored[0].x; player.y=scored[0].y;
    }
  };
  ejectPlayer(G.you, G.opp); ejectPlayer(G.opp, G.you);
  if(areAdjacentOrSame(G.you, G.opp)){
    const alt = getReachable(G.you.x, G.you.y).find(p => !areAdjacentOrSame(p, G.opp));
    if(alt){ G.you.x=alt.x; G.you.y=alt.y; }
  }
  Sound.eject(); haptic([15,30,15,30,15]);
}

