function readName(){
  const v=$('name-input').value.trim();
  App.playerName=v||'Jugador';
  try { localStorage.setItem('rally_name', App.playerName); } catch(e){}
}

// ============================================================
// OT — Torneo online x4 (con amigos + CPUs de relleno)
// Estructura en Firebase (rooms/{code}):
//   type:'tourney', status:'waiting'|'playing'|'lobby'
//   players/{s0..s3}: {name, color, uid, cpu?}   (s0 = anfitrión)
//   bracket/r1/{m0,m1}: {a,b,winner} · bracket/f/winner
//   matches/{m0|m1|f}: mismo protocolo que una sala 2p (game/, presence/)
//                      + spec/ (estado para espectar) + result/{winner}
// Cada partida humano-vs-humano usa el motor online existente apuntando
// Net.ref al nodo del match. Humano-vs-CPU corre el motor offline local y
// el humano publica el estado. CPU-vs-CPU la simula el anfitrión.
// ============================================================
const SEAT_COLORS = { s0:'#2B4DE0', s1:'#C92A2A', s2:'#2B8C4E', s3:'#8A3FC9' };
const CPU_GRAY = '#8A8A90';
const CPU_NAMES = ['Beto','Rulo','Cacho','Pipa','Tato','Coco','Pocho','Turco','Chino','Flaco','Nino','Quique'];

const OT = {
  active:false, ref:null, code:null, mySeat:null,
  uid: Math.random().toString(36).slice(2,10),
  players:{}, br:null, _phase:null, _leaving:false,
  inMatch:false, myMatchId:null, matchA:null, matchB:null, master:false,
  myDone:false, eliminated:false, finished:false, _finalHandled:false,
  specId:null, _specRef:null, _specSeats:null,

  resetRunFlags(){
    this.inMatch=false; this.myMatchId=null; this.matchA=null; this.matchB=null;
    this.master=false; this.myDone=false; this.eliminated=false;
    this.finished=false; this._finalHandled=false; this.stopSpec();
  },
  detachRoom(){
    try{ if(this.ref){ this.ref.child('players').off(); this.ref.child('status').off(); this.ref.child('bracket').off(); } }catch(e){}
  },
  clearColors(){
    document.documentElement.style.removeProperty('--you-accent');
    document.documentElement.style.removeProperty('--opp-accent');
  },
  applyColors(me, opp){
    const root=document.documentElement;
    if(me && me.color)  root.style.setProperty('--you-accent', me.color);
    if(opp) root.style.setProperty('--opp-accent', opp.color || CPU_GRAY);
  },
  cleanupLocal(){
    this.detachRoom(); this.stopSpec(); this.clearColors();
    this.active=false; this.ref=null; this.code=null; this.mySeat=null;
    this.players={}; this.br=null; this._phase=null;
    this.resetRunFlags();
  },

  // ---- Sala / lobby ----
  setup(ref, code, seat){
    this.detachRoom();
    this.active=true; this.ref=ref; this.code=code; this.mySeat=seat;
    this._phase='lobby'; this._leaving=false; this.resetRunFlags();

    ref.child('players').on('value', s=>{
      const v=s.val();
      if(v===null){
        if(this.active && !this._leaving){ toast('La sala se cerró.'); this.cleanupLocal(); G.running=false; show('home'); }
        return;
      }
      this.players=v;
      if(App.screen==='lobby' && this._phase!=='playing') this.renderLobby();
      if(App.screen==='othub') this.renderHub();
    });
    ref.child('status').on('value', s=>{
      const st=s.val();
      if(st==='playing' && this._phase!=='playing'){ this.route(); }
      else if(st==='lobby' && this._phase==='playing'){
        this._phase='lobby'; this.resetRunFlags(); this.clearColors(); this.showLobby();
      }
    });
    ref.child('bracket').on('value', s=>{
      this.br=s.val()||null;
      const b=this.br;
      if(b && b.r1){
        const w0=b.r1.m0 && b.r1.m0.winner, w1=b.r1.m1 && b.r1.m1.winner;
        const fw=b.f && b.f.winner;
        if(w0 && w1 && !fw && !this._finalHandled && this._phase==='playing'){
          this._finalHandled=true;
          if(w0===this.mySeat || w1===this.mySeat){
            toast('¡A la final! ⚔️');
            setTimeout(()=>{ if(this.active && this._phase==='playing') this.beginMatch('f', w0, w1); }, 2500);
          } else if(this.mySeat==='s0' && this.players[w0] && this.players[w0].cpu && this.players[w1] && this.players[w1].cpu){
            this.simulate('f', w0, w1);
          }
        }
        if(fw) this.finished=true;
      }
      if(App.screen==='othub') this.renderHub();
    });
  },

  async enableTourney(){
    if(DEMO || !fbDb){ toast('El torneo online necesita conexión.'); return false; }
    if(!Net.ref || Net.role!=='host'){ toast('Primero creá la sala.'); return false; }
    try{
      const g=(await Net.ref.child('guest').get()).val();
      if(g && g.name){ toast('Cambiá el modo antes de que entre tu rival.'); return false; }
    }catch(e){}
    const players={ s0:{ name:App.playerName||'Jugador', color:SEAT_COLORS.s0, uid:this.uid } };
    await Net.ref.update({ type:'tourney', players, guest:null, status:'waiting' });
    this.setup(Net.ref, Net.code, 's0');
    this.showLobby();
    return true;
  },

  // Volver de torneo a sala 2p (solo si no entró nadie más)
  disableTourney(){
    const others=Object.keys(this.players||{}).filter(k=>k!=='s0');
    if(others.length){ toast('Ya hay jugadores en el torneo.'); return false; }
    const ref=this.ref, code=this.code;
    this._leaving=true;                    // evita el aviso de "sala cerrada"
    this.cleanupLocal();
    ref.update({ type:null, players:null, status:'waiting' });
    Net.ref=ref; Net.code=code; Net.role='host';
    $('ot-box').style.display='none';
    $('wait-text').textContent='Esperando rival…';
    return true;
  },

  // GUEST: reclamar un asiento libre (transacción por asiento)
  async joinAsGuest(ref, code){
    const room=(await ref.get()).val()||{};
    if(room.status==='playing') return { ok:false, reason:'llena' };
    let claimed=null;
    for(const s of ['s1','s2','s3']){
      const r=await ref.child('players/'+s).transaction(cur=>{
        if(cur===null) return { name:App.playerName||'Jugador', color:SEAT_COLORS[s], uid:OT.uid };
        return; // ocupado → abortar e intentar el siguiente
      });
      if(r.committed && r.snapshot.val() && r.snapshot.val().uid===OT.uid){ claimed=s; break; }
    }
    if(!claimed) return { ok:false, reason:'llena' };
    try{ ref.child('players/'+claimed).onDisconnect().remove(); }catch(e){}
    App.roomCode=code; App.isHost=false;
    this.setup(ref, code, claimed);
    return { ok:true, tourney:true };
  },

  showLobby(){
    const host=(this.mySeat==='s0');
    $('lobby-created').style.display='flex'; $('lobby-join').style.display='none';
    $('code-out').textContent=this.code||App.roomCode||'····';
    $('btn-demo-start').style.display='none';
    $('mode-select').style.display= host?'flex':'none';
    $('btn-share').style.display= host?'block':'none';
    $('mode-t4').classList.add('is-on'); $('mode-single').classList.remove('is-on'); $('mode-bo5').classList.remove('is-on');
    $('ot-box').style.display='flex';
    $('btn-ot-start').style.display= host?'block':'none';
    const go=$('btn-online-start'); if(go) go.style.display='none';
    $('wait-text').textContent= host ? 'Los lugares libres se completan con CPUs' : 'Esperando que el anfitrión inicie…';
    this.renderLobby();
    show('lobby');
  },

  renderLobby(){
    const box=$('ot-list'); if(!box) return;
    box.innerHTML='';
    for(const s of ['s0','s1','s2','s3']){
      const p=this.players[s];
      const row=document.createElement('div');
      if(p){
        row.className='ot-row';
        const tag = (s===this.mySeat) ? 'vos' : (s==='s0' ? 'anfitrión' : (p.cpu?'CPU':''));
        row.innerHTML=`<span class="p-dot" style="background:${p.color||CPU_GRAY}"></span><span>${escHtml(p.name)}</span><span class="ot-tag">${tag}</span>`;
      } else {
        row.className='ot-row is-free';
        row.innerHTML=`<span class="p-dot" style="background:${CPU_GRAY}"></span><span>— libre —</span><span class="ot-tag">CPU al iniciar</span>`;
      }
      box.appendChild(row);
    }
  },

  pickCpuName(used){
    const free=CPU_NAMES.filter(n=>!used.has(n));
    const n=free.length?free[Math.floor(Math.random()*free.length)]:('CPU '+Math.floor(Math.random()*90+10));
    used.add(n); return n;
  },

  // HOST: completar con CPUs, armar bracket y arrancar
  async start(){
    const btn=$('btn-ot-start'); btn.disabled=true; btn.textContent='Iniciando…';
    try{
      const ps=Object.assign({}, this.players);
      const used=new Set(Object.values(ps).map(p=>p.name));
      for(const s of ['s1','s2','s3']){
        if(!ps[s]) ps[s]={ name:this.pickCpuName(used), color:CPU_GRAY, cpu:true };
      }
      const bracket={ r1:{ m0:{a:'s0', b:'s3'}, m1:{a:'s1', b:'s2'} } };
      await this.ref.update({ players:ps, bracket, matches:null, status:'playing' });
    }catch(e){ console.warn(e); toast('No se pudo iniciar el torneo.'); }
    btn.disabled=false; btn.textContent='▸ Iniciar torneo';
  },

  // ---- Ruteo de partidas ----
  async route(){
    this._phase='playing';
    this.myDone=false; this.eliminated=false; this.finished=false; this._finalHandled=false;
    try{ this.ref.child('players/'+this.mySeat).onDisconnect().cancel(); }catch(e){}
    let r1=null;
    try{
      this.players=(await this.ref.child('players').get()).val()||this.players;
      r1=(await this.ref.child('bracket/r1').get()).val();
    }catch(e){}
    if(!r1) return;
    const mine=(r1.m0.a===this.mySeat||r1.m0.b===this.mySeat) ? ['m0',r1.m0] : ['m1',r1.m1];
    this.beginMatch(mine[0], mine[1].a, mine[1].b);
    if(this.mySeat==='s0'){
      for(const mid of ['m0','m1']){
        const m=r1[mid], pa=this.players[m.a], pb=this.players[m.b];
        if(pa && pa.cpu && pb && pb.cpu) this.simulate(mid, m.a, m.b);
      }
    }
  },

  beginMatch(mid, a, b){
    this.stopSpec();
    this.inMatch=true; this.myMatchId=mid; this.matchA=a; this.matchB=b; this.myDone=false;
    App.matchMode='single';
    if(App.wallsMode) exitSpecialMode();
    const oppSeat=(a===this.mySeat)?b:a;
    const me=this.players[this.mySeat], opp=this.players[oppSeat];
    App.oppName=opp.name;
    Tourney.active=false;
    if(opp.cpu){
      // Partida local vs CPU; publico el estado para que la puedan espectar
      this.master=true; App.online=false;
      show('game'); startGame();
      this.applyColors(me, opp);
      this.pushSpec();
    } else {
      const role=(a===this.mySeat)?'host':'guest';
      this.master=(role==='host');
      App.online=true;
      Net.code=this.code; Net.role=role;
      Net.ref=this.ref.child('matches/'+mid);
      Net.onStart=(bs)=>{
        Net.stopListenStart();
        startOnlineGame(bs, role);
        OT.applyColors(me, opp);
        if(OT.master) OT.pushSpec();
      };
      Net.listenStart();
      if(role==='host'){ buildBoard(); Net.pushStart(serializeBoard()); }
    }
  },

  // CPU vs CPU: el anfitrión la resuelve con una simulación breve
  simulate(mid, a, b){
    try{ this.ref.child('matches/'+mid+'/spec').set({ note:'cpu' }); }catch(e){}
    const path=(mid==='f') ? 'bracket/f/winner' : 'bracket/r1/'+mid+'/winner';
    setTimeout(()=>{
      if(!this.active || this._phase!=='playing' || !this.ref) return;
      const winner=Math.random()<0.5 ? a : b;
      this.ref.child('matches/'+mid+'/result').set({ winner }).catch(()=>{});
      this.ref.child(path).set(winner).catch(()=>{});
    }, 9000 + Math.random()*9000);
  },

  // ---- Fin de mi partida (lo llama endGame / abandono) ----
  onMyMatchEnd(youHp, oppHp){
    const meIsA=(this.matchA===this.mySeat);
    let winner;
    if(youHp!==oppHp) winner=(youHp>oppHp) ? this.mySeat : (meIsA?this.matchB:this.matchA);
    else winner=(G.turnCount%2===0) ? this.matchA : this.matchB;  // empate: determinista en ambos clientes
    if(this.master) this.pushSpec();
    const mid=this.myMatchId;
    const path=(mid==='f') ? 'bracket/f/winner' : 'bracket/r1/'+mid+'/winner';
    try{
      this.ref.child('matches/'+mid+'/result').set({ winner }).catch(()=>{});
      this.ref.child(path).set(winner).catch(()=>{});
    }catch(e){}
    if(G.online) Net.detachMatch();
    G.online=false; G.running=false;
    this.inMatch=false; this.myDone=true;
    if(winner!==this.mySeat) this.eliminated=true;
    this.clearColors();
    show('othub'); this.renderHub();
  },

  // ---- Estado para espectadores ----
  pushSpec(){
    try{
      if(!this.active || !this.ref || !this.myMatchId || !this.master) return;
      let A,B;
      if(this.matchA===this.mySeat){ A=G.you; B=G.opp; } else { A=G.opp; B=G.you; }
      this.ref.child('matches/'+this.myMatchId+'/spec').set({
        board: serializeBoard(), turn: G.turnCount,
        A:{ x:A.x, y:A.y, hp:Math.max(0,A.hp) },
        B:{ x:B.x, y:B.y, hp:Math.max(0,B.hp) },
      }).catch(()=>{});
    }catch(e){}
  },

  // ---- Hub del torneo ----
  renderHub(){
    const b=this.br||{}, r1=b.r1||{}, fw=b.f&&b.f.winner;
    const w0=r1.m0&&r1.m0.winner, w1=r1.m1&&r1.m1.winner;
    const title=$('othub-title'), sub=$('othub-sub');
    title.classList.remove('is-win','is-lose');
    if(this.finished && fw){
      const champ=this.players[fw]||{};
      if(fw===this.mySeat){ title.textContent='🏆 Ganaste el torneo'; title.classList.add('is-win'); }
      else if((w0===this.mySeat||w1===this.mySeat)){ title.textContent='Perdiste la final'; title.classList.add('is-lose'); }
      else { title.textContent='Torneo terminado'; }
      sub.innerHTML=`Campeón: <span class="p-dot" style="background:${champ.color||CPU_GRAY}"></span> <b>${escHtml(champ.name||'?')}</b>`;
    } else if(this.eliminated){
      title.textContent='Eliminado'; title.classList.add('is-lose');
      sub.textContent='Podés espectar las otras partidas';
    } else if(this.myDone){
      title.textContent='Semifinal ganada'; title.classList.add('is-win');
      sub.textContent='Esperando al otro finalista…';
    } else {
      title.textContent='Torneo'; sub.textContent='';
    }
    $('btn-ot-room').style.display=(this.finished&&fw)?'block':'none';

    const list=$('othub-list'); list.innerHTML='';
    const addMatch=(label, mid, a, bSeat, winner, running)=>{
      const box=document.createElement('div'); box.className='ot-match';
      const mk=(seat)=>{
        const p=this.players[seat]||{};
        const cls= winner ? (winner===seat?'ot-p is-winner':'ot-p is-loser') : 'ot-p';
        return `<div class="${cls}"><span class="p-dot" style="background:${p.color||CPU_GRAY}"></span>${escHtml(p.name||'?')}${winner===seat?' ✓':''}</div>`;
      };
      box.innerHTML=`<span class="ot-vs">${label}</span>${mk(a)}${mk(bSeat)}`;
      if(running){
        const btn=document.createElement('button');
        btn.className='btn btn--outline'; btn.textContent='👁 Espectar';
        btn.addEventListener('click', ()=>OT.spectate(mid, a, bSeat));
        box.appendChild(btn);
      }
      list.appendChild(box);
    };
    if(r1.m0) addMatch('Semifinal 1','m0', r1.m0.a, r1.m0.b, w0, !w0);
    if(r1.m1) addMatch('Semifinal 2','m1', r1.m1.a, r1.m1.b, w1, !w1);
    if(w0 && w1) addMatch('Final','f', w0, w1, fw, !fw);
  },

  // ---- Espectador ----
  spectate(mid, a, b){
    this.stopSpec();
    this.specId=mid; this._specSeats={a,b};
    this._specRef=this.ref.child('matches/'+mid);
    $('spec-board').innerHTML=''; $('spec-note').textContent='Conectando…';
    this.renderSpecHead(null);
    show('spectate');
    this._specRef.child('spec').on('value', s=>this.renderSpec(s.val()));
    this._specRef.child('result').on('value', s=>{
      const r=s.val();
      if(r && r.winner){
        const p=this.players[r.winner]||{};
        $('spec-note').textContent='🏁 Ganó '+(p.name||'?');
        setTimeout(()=>{ if(App.screen==='spectate'){ OT.stopSpec(); show('othub'); OT.renderHub(); } }, 2800);
      }
    });
  },
  stopSpec(){
    try{
      if(this._specRef){ this._specRef.child('spec').off(); this._specRef.child('result').off(); }
    }catch(e){}
    this._specRef=null; this.specId=null; this._specSeats=null;
  },
  renderSpecHead(spec){
    const st=this._specSeats||{};
    const pa=this.players[st.a]||{}, pb=this.players[st.b]||{};
    const hpA=spec&&spec.A?spec.A.hp:'—', hpB=spec&&spec.B?spec.B.hp:'—';
    $('spec-head').innerHTML=
      `<span class="p-dot" style="background:${pa.color||CPU_GRAY}"></span>${escHtml(pa.name||'?')} <b>${hpA}</b>`+
      `<span style="color:var(--muted); font-weight:400;">vs</span>`+
      `<b>${hpB}</b> ${escHtml(pb.name||'?')}<span class="p-dot" style="background:${pb.color||CPU_GRAY}"></span>`;
  },
  renderSpec(spec){
    if(!spec){ $('spec-note').textContent='Esperando datos…'; return; }
    if(spec.note==='cpu'){
      $('spec-board').innerHTML='';
      $('spec-note').textContent='🤖 Partida entre CPUs — se resuelve sola…';
      this.renderSpecHead(null);
      return;
    }
    this.renderSpecHead(spec);
    $('spec-note').textContent='Turno '+(spec.turn||0);
    const cells=String(spec.board||'');
    const n=Math.round(Math.sqrt(cells.length))||7;
    const boardEl=$('spec-board');
    boardEl.innerHTML='';
    boardEl.style.gridTemplateColumns=`repeat(${n},1fr)`;
    boardEl.style.gridTemplateRows=`repeat(${n},1fr)`;
    const st=this._specSeats||{};
    const colA=(this.players[st.a]||{}).color||CPU_GRAY;
    const colB=(this.players[st.b]||{}).color||CPU_GRAY;
    for(let y=0;y<n;y++) for(let x=0;x<n;x++){
      const div=document.createElement('div'); div.className='cell';
      const t=CODE_CELL[cells[y*n+x]]||'empty';
      if(t==='power_dmg'){ const s=document.createElement('span'); s.className='item-atk'; s.textContent='🗡️'; div.appendChild(s); }
      else if(t==='power_def'){ const s=document.createElement('span'); s.className='item-def'; s.textContent='◈'; div.appendChild(s); }
      else if(t==='down'){ const s=document.createElement('span'); s.className='down'; s.textContent='×'; div.appendChild(s); }
      else if(t==='ring'){ const s=document.createElement('span'); s.className='item-ring'; div.appendChild(s); }
      const here=[];
      if(spec.A && spec.A.x===x && spec.A.y===y) here.push(colA);
      if(spec.B && spec.B.x===x && spec.B.y===y) here.push(colB);
      here.forEach((c,i)=>{
        const m=document.createElement('div');
        m.className='player-marker';
        m.style.cssText=`background:${c}; left:20%; top:20%;`+(i===1?'transform:translate(20%,-20%) scale(.75);':'');
        div.appendChild(m);
      });
      boardEl.appendChild(div);
    }
  },

  // ---- Volver a la sala / salir ----
  backToLobby(){
    this.stopSpec();
    if(this.mySeat==='s0'){
      const ps={};
      for(const k in this.players){ if(this.players[k] && !this.players[k].cpu) ps[k]=this.players[k]; }
      Net.ref=this.ref; Net.code=this.code; Net.role='host';
      this.ref.update({ players:ps, bracket:null, matches:null, status:'lobby' }).catch(()=>{});
    }
    this._phase='lobby'; this.resetRunFlags(); this.clearColors();
    this.showLobby();
  },
  leaveTournament(){
    this._leaving=true;
    try{
      // Si me voy con la partida sin definir, el rival pasa de ronda
      if(this.inMatch && !this.myDone && this.ref && this.myMatchId){
        const oppSeat=(this.matchA===this.mySeat)?this.matchB:this.matchA;
        const path=(this.myMatchId==='f')?'bracket/f/winner':'bracket/r1/'+this.myMatchId+'/winner';
        this.ref.child('matches/'+this.myMatchId+'/result').set({ winner:oppSeat }).catch(()=>{});
        this.ref.child(path).set(oppSeat).catch(()=>{});
      }
    }catch(e){}
    try{ if(G.online) Net.detachMatch(); }catch(e){}
    G.online=false; G.running=false; G.phase='idle';
    try{
      if(this.mySeat==='s0') this.ref.remove();
      else if(this.ref && this._phase!=='playing') this.ref.child('players/'+this.mySeat).remove();
    }catch(e){}
    this.cleanupLocal();
    show('home');
  },
};
