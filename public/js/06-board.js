const G = {
  running: false,
  phase: 'idle',
  board: [],
  turnCount: 0,
  online: false,    // partida online en curso
  flip: false,      // true para el invitado (tablero espejado 180°)
  skinYou: null,    // emoji de skin (easter egg Messi) o null
  skinOpp: null,
  _duelResolved: false,
  _revealShown: false,
  you: { x:6, y:6, hp:100, prevX:6, prevY:6, buffs:{dmg:0, def:0} },
  opp: { x:0, y:0, hp:100, prevX:0, prevY:0, buffs:{dmg:0, def:0} },
  yourMove: null,
  oppMove: null,
  justDueled: false,
  duel: {
    time: 0,
    pass: 1,
    stopped: false,
    yourScore: 0,
    oppScore: 0,
    yourStopped: false,
    oppStopped: false,
    yourStoppedPos: 0,
    oppStoppedPos: 0,
    raf: null,
    lastTs: 0,
  },
};

function easeInOutCubic(t){
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function timeToPosition(time){
  const cycleTime = time % CFG.duelCycleDuration;
  const halfCycle = CFG.duelCycleDuration / 2;
  
  if(cycleTime < halfCycle){
    const t = cycleTime / halfCycle;
    return easeInOutCubic(t);
  } else {
    const t = (cycleTime - halfCycle) / halfCycle;
    return 1 - easeInOutCubic(t);
  }
}

function buildSpeedometer(){
  const ticksContainer = $('speedo-ticks');
  ticksContainer.innerHTML = '';
  
  for(let i=0; i<=10; i++){
    const tick = document.createElement('div');
    tick.className = 'speedo-tick' + (i % 5 === 0 ? ' is-major' : '');
    tick.style.left = (i * 10) + '%';
    ticksContainer.appendChild(tick);
  }
}

// Maneja ambas agujas. En online, la del rival aparece sólo cuando llega su
// posición por Firebase (efecto "revelado con delay").
function updateNeedles(currentPos){
  const needleYou = $('speedo-needle');
  const needleOpp = $('speedo-needle-opponent');
  
  // Aguja del jugador
  if(G.duel.yourStopped){
    needleYou.style.left = (G.duel.yourStoppedPos * 100) + '%';
    needleYou.style.opacity = '1';
  } else {
    needleYou.style.left = (currentPos * 100) + '%';
    needleYou.style.opacity = '1';
  }
  
  // Aguja del rival
  if(G.online){
    // Online: oculta hasta que el rival frenó (su dato llegó por Firebase).
    if(G.duel.oppStopped){
      needleOpp.style.left = (G.duel.oppStoppedPos * 100) + '%';
      needleOpp.style.opacity = '0.45';
    } else {
      needleOpp.style.opacity = '0';   // todavía no sabemos dónde frenó
    }
  } else {
    // Offline (vs CPU): la aguja acompaña hasta que la CPU frena.
    if(G.duel.oppStopped){
      needleOpp.style.left = (G.duel.oppStoppedPos * 100) + '%';
      needleOpp.style.opacity = '0.45';
    } else {
      needleOpp.style.left = (currentPos * 100) + '%';
      needleOpp.style.opacity = '0.45';
    }
  }
}

function buildBoard(){
  const n = CFG.boardSize;
  G.board = [];
  for(let y=0; y<n; y++){
    for(let x=0; x<n; x++){
      G.board.push({ x, y, type:'empty' });
    }
  }
  // Modo Paredes: generar barreras aleatorias (garantizando conectividad).
  if(App.wallsMode){ Walls.generate(n, CFG.wallsCount); } else { Walls.clear(); }
  const startPos = [{x:n-1, y:n-1},{x:0, y:0}];
  const isStart = (x,y)=> startPos.some(p=>p.x===x && p.y===y);
  const placeRandom = (type, count)=>{
    let placed = 0, guard = 0;
    while(placed < count && guard < count*100){
      guard++;
      const x = Math.floor(Math.random()*n);
      const y = Math.floor(Math.random()*n);
      const cell = cellAt(x,y);
      if(cell.type === 'empty' && !isStart(x,y)){ cell.type = type; placed++; }
    }
  };
  // En mapas más grandes, sumar algunos ítems extra para que no quede vacío.
  const scale = (n >= 9) ? 2 : 1;
  placeRandom('power_dmg', CFG.powerDmgCount * scale);
  placeRandom('power_def', CFG.powerDefCount * scale);
  placeRandom('down', CFG.downCount * scale);
}
function cellAt(x,y){ return G.board[y*CFG.boardSize + x]; }
function countItems(type){ return G.board.filter(c => c.type === type).length; }

// ---- Serialización del tablero para online ----
const CELL_CODE = { empty:'e', power_dmg:'a', power_def:'d', down:'x', ring:'r' };
const CODE_CELL = { e:'empty', a:'power_dmg', d:'power_def', x:'down', r:'ring' };
function serializeBoard(){
  const cells = G.board.map(c => CELL_CODE[c.type] || 'e').join('');
  // En modo Paredes anteponemos tamaño y paredes: "W<size>~<paredes>~<celdas>".
  // Separador de campos "~" (las claves de pared contienen "|" y ",", no "~").
  if(App.wallsMode){
    return `W${CFG.boardSize}~${Walls.serialize()}~${cells}`;
  }
  return cells;
}
function deserializeBoard(str){
  // ¿Formato con paredes? "W<size>~<paredes>~<celdas>"
  if(typeof str==='string' && str[0]==='W'){
    const firstSep = str.indexOf('~');
    const secondSep = str.indexOf('~', firstSep+1);
    const size = parseInt(str.slice(1, firstSep), 10) || CFG.wallsBoardSize;
    const wallsStr = str.slice(firstSep+1, secondSep);
    const cells = str.slice(secondSep+1);
    App.wallsMode = true;
    CFG.boardSize = size;
    Walls.deserialize(wallsStr);
    const n = size;
    G.board = [];
    for(let y=0; y<n; y++) for(let x=0; x<n; x++){
      const ch = cells[y*n + x] || 'e';
      G.board.push({ x, y, type: CODE_CELL[ch] || 'empty' });
    }
    return;
  }
  // Formato clásico (tablero normal).
  App.wallsMode = false;
  CFG.boardSize = CFG.boardSizeDefault;
  Walls.clear();
  const n = CFG.boardSize;
  G.board = [];
  for(let y=0; y<n; y++){
    for(let x=0; x<n; x++){
      const ch = str[y*n + x] || 'e';
      G.board.push({ x, y, type: CODE_CELL[ch] || 'empty' });
    }
  }
}
// Perspectiva: el invitado ve el tablero espejado 180°.
// Convierte una coord canónica a coord visual (o viceversa, es involutiva).
function viewCoord(x, y){
  if(!G.flip) return { x, y };
  const n = CFG.boardSize;
  return { x: n-1-x, y: n-1-y };
}

function regenerateItems(){
  const n = CFG.boardSize;
  const isPlayer = (x,y)=> (G.you.x===x && G.you.y===y) || (G.opp.x===x && G.opp.y===y);
  const findEmpty = ()=>{
    for(let i=0;i<50;i++){
      const x = Math.floor(Math.random()*n), y = Math.floor(Math.random()*n);
      if(cellAt(x,y).type==='empty' && !isPlayer(x,y)) return {x,y};
    }
    return null;
  };
  if(countItems('power_dmg') < CFG.maxPowerDmg){ const p=findEmpty(); if(p) cellAt(p.x,p.y).type='power_dmg'; }
  if(countItems('power_def') < CFG.maxPowerDef){ const p=findEmpty(); if(p) cellAt(p.x,p.y).type='power_def'; }
  const p=findEmpty(); if(p) cellAt(p.x,p.y).type='down';
  // Anillo multicolor: una vez por partida, raro, avanzada la partida, NO en torneo
  if(!Tourney.active && !G.ringSpawned && G.turnCount>=CFG.ringMinTurn && Math.random()<CFG.ringChancePerTurn){
    const rp=findEmpty();
    if(rp){ cellAt(rp.x,rp.y).type='ring'; G.ringSpawned=true; }
  }
  Sound.regen();
}

// ---- Easter egg "Messi" (cambio #3) ----
function isMessi(name){ return (name||'').trim().toLowerCase()==='messi'; }
// Resuelve skins y nombres según las reglas del easter egg.
// Modifica G.skinYou, G.skinOpp y, si corresponde, App.oppName.
function resolveSkins(){
  G.skinYou = null; G.skinOpp = null;
  const youMessi = isMessi(App.playerName);
  const oppMessi = isMessi(App.oppName);
  if(youMessi && oppMessi){
    // Ambos Messi: vos seguís con tu bandera argentina, y al rival lo ves
    // como Brasil / "Vinicius".
    G.skinYou = '🇦🇷';
    G.skinOpp = '🇧🇷';
    App.oppName = 'Vinicius';
  } else {
    if(youMessi) G.skinYou = '🇦🇷';
    if(oppMessi) G.skinOpp = '🇦🇷';
  }
}

function renderBoard(){
  const boardEl = $('board'); boardEl.innerHTML = '';
  const n = CFG.boardSize;
  boardEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  boardEl.classList.toggle('is-large', n >= 9);
  const reachable = G.phase === 'choose' ? getReachable(G.you.x, G.you.y) : [];
  // Recorremos en orden VISUAL. Para cada celda visual, hallamos su coord canónica.
  for(let vy=0; vy<n; vy++){
    for(let vx=0; vx<n; vx++){
      // viewCoord es involutiva: visual->canónica usa la misma transformación
      const cn = viewCoord(vx, vy);
      const x = cn.x, y = cn.y;
      const cell = cellAt(x,y);
      const div = document.createElement('div'); div.className = 'cell'; div.dataset.x = x; div.dataset.y = y;
      if(cell.type === 'power_dmg'){ const s=document.createElement('span'); s.className='item-atk'; s.textContent='🗡️'; div.appendChild(s); }
      else if(cell.type === 'power_def'){ const s=document.createElement('span'); s.className='item-def'; s.textContent='◈'; div.appendChild(s); }
      else if(cell.type === 'down'){ const s=document.createElement('span'); s.className='down'; s.textContent='×'; div.appendChild(s); }
      else if(cell.type === 'ring'){ const s=document.createElement('span'); s.className='item-ring'; div.appendChild(s); }
      const youHere = (G.you.x === x && G.you.y === y);
      const oppHere = (G.opp.x === x && G.opp.y === y);
      const shielded = G.justDueled;   // tregua post-duelo: burbuja visible
      if(youHere){
        const m=document.createElement('div'); m.className='player-marker is-you';
        if(shielded) m.classList.add('has-shield');
        if(G.skinYou){ m.classList.add('has-skin'); m.textContent=G.skinYou; }
        div.appendChild(m);
      }
      if(oppHere){
        const m=document.createElement('div'); m.className='player-marker is-opp';
        if(shielded) m.classList.add('has-shield');
        if(G.skinOpp){ m.classList.add('has-skin'); m.textContent=G.skinOpp; }
        if(youHere){ div.classList.add('is-both-here'); m.style.transform='translate(20%,-20%) scale(.75)'; }
        div.appendChild(m);
      }
      if(reachable.some(p=>p.x===x && p.y===y)){
        div.classList.add('is-reachable');
        div.addEventListener('click', ()=>{ Sound.click(); haptic(6); onPlayerMove(x, y); });
      }
      // Paredes: chequeo el borde con la celda visual de la DERECHA y la de ABAJO.
      // Convierto los vecinos visuales a canónicos para consultar Walls.
      if(Walls.active()){
        if(vx < n-1){
          const rc = viewCoord(vx+1, vy);           // vecino visual derecho → canónico
          if(Walls.hasOrtho(x, y, rc.x, rc.y)){ const w=document.createElement('div'); w.className='wall-seg is-right'; div.appendChild(w); }
        }
        if(vy < n-1){
          const bc = viewCoord(vx, vy+1);           // vecino visual inferior → canónico
          if(Walls.hasOrtho(x, y, bc.x, bc.y)){ const w=document.createElement('div'); w.className='wall-seg is-bottom'; div.appendChild(w); }
        }
      }
      boardEl.appendChild(div);
    }
  }
}
// ---- Sistema de paredes (Modo Paredes) ----
// Una pared vive en el borde ENTRE dos casillas ortogonalmente adyacentes.
// Se identifica con una clave canónica independiente del orden de las celdas.
const Walls = {
  set: new Set(),
  clear(){ this.set = new Set(); },
  active(){ return this.set.size > 0; },
  key(x1,y1,x2,y2){
    // Orden canónico para que (a,b) y (b,a) den la misma clave.
    if(y1>y2 || (y1===y2 && x1>x2)) { [x1,x2]=[x2,x1]; [y1,y2]=[y2,y1]; }
    return `${x1},${y1}|${x2},${y2}`;
  },
  hasOrtho(x1,y1,x2,y2){ return this.set.has(this.key(x1,y1,x2,y2)); },
  // ¿Hay pared que impida moverse de (x,y) a (nx,ny)? (adyacencia de rey)
  blocks(x,y,nx,ny){
    const dx = nx-x, dy = ny-y;
    // Paso ortogonal: bloqueado si hay pared en ese borde.
    if(dx===0 || dy===0){
      return this.hasOrtho(x,y,nx,ny);
    }
    // Paso diagonal: se bloquea SOLO si la esquina está cerrada por ambos lados,
    // es decir, las dos paredes que forman ese codo están presentes. Si al menos
    // un lado está abierto, la diagonal puede bordear la pared.
    // Lado del origen: pared al costado (x→x+dx) y pared arriba/abajo (y→y+dy).
    const sideH = this.hasOrtho(x, y, x+dx, y);   // borde horizontal del codo
    const sideV = this.hasOrtho(x, y, x, y+dy);   // borde vertical del codo
    // Cerrado también si las dos paredes del lado del destino forman la esquina.
    const destH = this.hasOrtho(x, y+dy, nx, ny); // borde horizontal (fila destino)
    const destV = this.hasOrtho(x+dx, y, nx, ny); // borde vertical (columna destino)
    // La esquina está sellada si cualquier par que la rodea está completo.
    const cornerClosed = (sideH && sideV) || (destH && destV) ||
                         (sideH && destH) || (sideV && destV);
    return cornerClosed;
  },
  // Genera segmentos de pared aleatorios (líneas de 2-3, algunas de 4-5),
  // garantizando que TODO el tablero siga siendo alcanzable (sin casillas
  // aisladas ni jugadores encerrados). Si un segmento rompe la conectividad,
  // se descarta.
  generate(n, targetWalls){
    this.clear();
    const startCells = [`${n-1},${n-1}`, `0,0`];
    let attempts = 0;
    while(this.set.size < targetWalls && attempts < targetWalls*40){
      attempts++;
      const horiz = Math.random() < 0.5;
      const len = (Math.random() < 0.72) ? (2 + Math.floor(Math.random()*2))   // 2-3
                                         : (4 + Math.floor(Math.random()*2));  // 4-5
      const sx = Math.floor(Math.random()*n);
      const sy = Math.floor(Math.random()*n);
      const seg = [];
      let ok = true;
      for(let i=0; i<len; i++){
        const cx = horiz ? sx + i : sx;
        const cy = horiz ? sy : sy + i;
        const ax = cx, ay = cy;
        const bx = horiz ? cx : cx + 1;
        const by = horiz ? cy + 1 : cy;
        if(bx>=n || by>=n){ ok=false; break; }
        if(startCells.includes(`${ax},${ay}`) || startCells.includes(`${bx},${by}`)){ ok=false; break; }
        const k = this.key(ax,ay,bx,by);
        if(this.set.has(k)){ ok=false; break; }   // no repetir
        seg.push(k);
      }
      if(!ok || !seg.length) continue;
      // Tentativamente agrego el segmento y verifico conectividad total.
      seg.forEach(k=>this.set.add(k));
      if(!this._fullyConnected(n)){
        seg.forEach(k=>this.set.delete(k));   // rompía el tablero: descartar
      }
    }
  },
  // BFS: ¿todas las casillas son alcanzables desde una esquina, respetando paredes?
  _fullyConnected(n){
    const seen = new Set(), q = [[n-1,n-1]];
    seen.add(`${n-1},${n-1}`);
    while(q.length){
      const [x,y] = q.shift();
      for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
        if(dx===0&&dy===0) continue;
        const nx=x+dx, ny=y+dy;
        if(nx<0||nx>=n||ny<0||ny>=n) continue;
        if(this.blocks(x,y,nx,ny)) continue;
        const kk = `${nx},${ny}`;
        if(!seen.has(kk)){ seen.add(kk); q.push([nx,ny]); }
      }
    }
    return seen.size === n*n;
  },
  // Serializa a string para el online: lista de claves separadas por ';'.
  serialize(){ return Array.from(this.set).join(';'); },
  deserialize(str){
    this.clear();
    if(!str) return;
    str.split(';').forEach(k=>{ if(k) this.set.add(k); });
  }
};

function getReachable(x, y){
  const n = CFG.boardSize, out = [];
  for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
    if(dx===0&&dy===0) continue;
    const nx=x+dx, ny=y+dy;
    if(nx>=0&&nx<n&&ny>=0&&ny<n){
      if(Walls.blocks(x, y, nx, ny)) continue;   // pared entre medio: no se puede pasar
      out.push({x:nx,y:ny});
    }
  }
  return out;
}
function areAdjacentOrSame(a, b){ return Math.abs(a.x-b.x)<=1 && Math.abs(a.y-b.y)<=1; }
// En Modo Paredes, dos casillas "adyacentes" no cuentan como contacto real
// si hay una pared entre medio (misma regla que bloquea el movimiento).
function wallSeparates(a, b){
  if(!App.wallsMode || !Walls.active()) return false;
  if(a.x===b.x && a.y===b.y) return false;
  return Walls.blocks(a.x, a.y, b.x, b.y);
}

