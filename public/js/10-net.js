// ---- Net: salas online sobre Firebase Realtime Database ----
const Net = {
  ref: null,          // referencia a rooms/{code}
  code: null,
  role: null,         // 'host' | 'guest'
  onReady: null,      // callback cuando ambos jugadores están

  // HOST: crea una sala con código único y espera al invitado
  async createRoom(){
    if(DEMO || !fbDb) return genCode();
    // Limpieza oportunista de salas viejas (#13): borra las de > 2 horas.
    this.cleanStaleRooms().catch(()=>{});
    // Genera un código que no esté en uso
    let code, snap, tries=0;
    do {
      code = genCode();
      snap = await fbDb.ref('rooms/'+code).get();
      tries++;
    } while(snap.exists() && tries<8);

    this.code = code;
    this.role = 'host';
    this.ref = fbDb.ref('rooms/'+code);

    await this.ref.set({
      status: 'waiting',
      host: { name: App.playerName },
      guest: null,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    // Nota: el auto-borrado por desconexión se desactivó para testear con
    // múltiples pestañas. La sala se limpia al salir con Net.leave().

    // Escucha la llegada del invitado
    this.ref.child('guest').on('value', s=>{
      const g = s.val();
      if(g && g.name){
        App.oppName = g.name;
        this.ref.child('status').set('ready');
        if(this.onReady) this.onReady({ role:'host', oppName:g.name });
      }
    });
    return code;
  },

  // Borra salas con más de 2 horas de antigüedad (limpieza oportunista, #13)
  async cleanStaleRooms(){
    if(!fbDb) return;
    const TWO_HOURS = 2*60*60*1000;
    const now = Date.now();
    const snap = await fbDb.ref('rooms').get();
    if(!snap.exists()) return;
    const rooms = snap.val();
    const dels = [];
    for(const code in rooms){
      const r = rooms[code];
      const created = (r && r.createdAt) || 0;
      if(typeof created==='number' && (now - created) > TWO_HOURS){
        dels.push(fbDb.ref('rooms/'+code).remove().catch(()=>{}));
      }
    }
    if(dels.length) await Promise.all(dels);
  },

  // GUEST: se une a una sala existente
  async joinRoom(code){
    if(DEMO || !fbDb){ return { ok:true, demo:true }; }
    const ref = fbDb.ref('rooms/'+code);
    const snap = await ref.get();
    if(!snap.exists())      return { ok:false, reason:'no-existe' };
    const room = snap.val();
    if(room.type==='tourney'){ return OT.joinAsGuest(ref, code); }
    if(room.guest && room.guest.name) return { ok:false, reason:'llena' };

    this.code = code;
    this.role = 'guest';
    this.ref = ref;
    App.oppName = (room.host && room.host.name) || 'Rival';

    await ref.child('guest').set({ name: App.playerName });

    if(this.onReady) this.onReady({ role:'guest', oppName: App.oppName });
    return { ok:true, oppName: App.oppName };
  },

  // ---- Sincronización de partida (Etapa 2) ----
  onStart: null,   // callback cuando arranca la partida (recibe boardStr)

  // HOST: sube el tablero serializado y marca la sala como "playing"
  async pushStart(boardStr){
    if(!this.ref) return;
    await this.ref.child('game').set({
      board: boardStr,
      turn: 0,
      mode: App.matchMode,   // 'single' | 'bo5'
      startedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await this.ref.child('status').set('playing');
  },

  // Ambos: escuchan el arranque de la partida (cuando aparece game.board)
  listenStart(){
    if(!this.ref) return;
    this.ref.child('game/board').on('value', s=>{
      const b = s.val();
      if(b && this.onStart){
        // Leer el modo elegido por el host (guest lo recibe)
        this.ref.child('game/mode').get().then(ms=>{
          App.matchMode = ms.val() || 'single';
          this.onStart(b);
        }).catch(()=>this.onStart(b));
      }
    });
  },

  stopListenStart(){
    if(this.ref) this.ref.child('game/board').off();
  },

  // ---- Revancha online (#6) ----
  onRematchState: null,  // callback({host,guest}) con quién aceptó la revancha
  // Marca que yo quiero revancha
  async pushRematch(){
    if(!this.ref) return;
    await this.ref.child('rematch/'+this.role).set(true);
  },
  // Escucha el estado de revancha de ambos
  listenRematch(){
    if(!this.ref) return;
    this.ref.child('rematch').on('value', s=>{
      const r = s.val() || {};
      if(this.onRematchState) this.onRematchState(r);
    });
  },
  stopListenRematch(){ if(this.ref) this.ref.child('rematch').off(); },
  // Limpia el estado de revancha y los datos de la partida anterior (host)
  async resetForRematch(){
    if(!this.ref) return;
    await this.ref.child('rematch').remove().catch(()=>{});
    await this.ref.child('game').remove().catch(()=>{});
  },

  // ---- Movimientos simultáneos (Etapa 3A) ----
  onMovesReady: null,   // callback(movesObj) cuando están los dos movimientos del turno
  onBoardUpdate: null,  // callback(boardStr) cuando el host regenera items
  _movesRef: null,

  // Sube mi movimiento (coords canónicas) para el turno dado
  async pushMove(turn, x, y){
    if(!this.ref) return;
    await this.ref.child('game/moves/'+turn+'/'+this.role).set({ x, y });
    // El host limpia el turno anterior (ya consumido) para no acumular datos.
    if(this.role==='host' && turn>0){
      this.ref.child('game/moves/'+(turn-1)).remove().catch(()=>{});
    }
  },

  onOppMoved: null,    // callback cuando el rival ya eligió (movimiento parcial)
  // Escucha los movimientos de un turno; dispara onMovesReady cuando hay host+guest
  listenMoves(turn){
    if(!this.ref) return;
    if(this._movesRef) this._movesRef.off();
    this._movesRef = this.ref.child('game/moves/'+turn);
    this._movesRef.on('value', s=>{
      const m = s.val();
      if(!m) return;
      const oppKey = this.role==='host' ? 'guest' : 'host';
      // Aviso parcial: el rival ya movió pero falta yo
      if(m[oppKey] && this.onOppMoved) this.onOppMoved();
      if(m.host && m.guest && this.onMovesReady){
        this._movesRef.off(); this._movesRef=null;
        this.onMovesReady(m);
      }
    });
  },

  // HOST: sube el board actualizado tras regenerar items
  async pushBoard(boardStr){
    if(!this.ref) return;
    await this.ref.child('game/board').set(boardStr);
  },

  // Escucha actualizaciones de board (para el guest tras regeneración)
  listenBoard(){
    if(!this.ref) return;
    this.ref.child('game/board').on('value', s=>{
      const b = s.val();
      if(b && this.onBoardUpdate) this.onBoardUpdate(b);
    });
  },
  stopListenBoard(){
    if(this.ref) this.ref.child('game/board').off();
  },

  // ---- Duelo sincronizado (Etapa 3B) ----
  onDuelScores: null,   // callback(scoresObj) cuando están los dos scores
  onEject: null,        // callback(positions) cuando el host resuelve un empate
  _duelRef: null,

  // Sube mi resultado del duelo (score + posición de aguja) para este encuentro
  async pushDuelScore(duelId, score, pos){
    if(!this.ref) return;
    await this.ref.child('game/duels/'+duelId+'/'+this.role).set({ score, pos });
  },

  onOppDuelStop: null,   // callback(pos) apenas el rival frena (antes que yo)
  // Escucha los scores del duelo; avisa cuando frena el rival y cuando hay ambos
  listenDuelScores(duelId){
    if(!this.ref) return;
    if(this._duelRef) this._duelRef.off();
    this._duelRef = this.ref.child('game/duels/'+duelId);
    this._oppShownThisDuel = false;
    const oppKey = this.role==='host' ? 'guest' : 'host';
    this._duelRef.on('value', s=>{
      const d = s.val();
      if(!d) return;
      // Apenas aparece el dato del rival, mostrar su aguja (una sola vez)
      if(d[oppKey] && !this._oppShownThisDuel && this.onOppDuelStop){
        this._oppShownThisDuel = true;
        this.onOppDuelStop(d[oppKey].pos, d[oppKey].score);
      }
      if(d.host && d.guest && this.onDuelScores){
        this._duelRef.off(); this._duelRef=null;
        this.onDuelScores(d);
      }
    });
  },

  // HOST: sube las posiciones tras un eject (empate). pos en coords canónicas.
  async pushEject(duelId, youPos, oppPos){
    if(!this.ref) return;
    await this.ref.child('game/ejects/'+duelId).set({ youPos, oppPos });
  },
  listenEject(duelId){
    if(!this.ref) return;
    this.ref.child('game/ejects/'+duelId).on('value', s=>{
      const e = s.val();
      if(e && this.onEject){ this.ref.child('game/ejects/'+duelId).off(); this.onEject(e); }
    });
  },

  // ---- Chat en vivo (solo online) ----
  // Vive en rooms/{code}/chat (nivel sala: persiste entre revanchas; se borra con
  // la sala en leave()). Cada mensaje usa push-id → orden cronológico gratis.
  onChatMessage: null,   // callback(msg) por cada mensaje nuevo
  _chatQueryRef: null,   // ref (sin límite) para poder soltar el listener
  async pushChat(text){
    if(!this.ref) return;
    const t = String(text).slice(0, 200);
    await this.ref.child('chat').push({
      from: this.role, name: App.playerName, text: t,
      ts: firebase.database.ServerValue.TIMESTAMP,
    });
  },
  listenChat(){
    if(!this.ref) return;
    this._chatQueryRef = this.ref.child('chat');
    // limitToLast: acota crecimiento y da historial (hasta 50) al reconectar.
    this._chatQueryRef.limitToLast(50).on('child_added', s=>{
      const m = s.val();
      if(m && this.onChatMessage) this.onChatMessage(m);
    });
  },
  stopChat(){
    if(this._chatQueryRef){ this._chatQueryRef.off('child_added'); this._chatQueryRef=null; }
    this.onChatMessage=null;
  },

  // ---- Presencia / abandono (cambio #2) ----
  onOpponentLeft: null,   // callback cuando el rival se desconecta o sale
  _presenceWatch: false,

  // Marca mi presencia y la del rival a vigilar. Se llama al iniciar la partida.
  startPresence(){
    if(!this.ref || this._presenceWatch) return;
    this._presenceWatch = true;
    const myKey  = this.role;                       // 'host' | 'guest'
    const oppKey = this.role==='host' ? 'guest' : 'host';
    // Mi presencia: se borra sola si me desconecto/cierro pestaña
    const myRef = this.ref.child('presence/'+myKey);
    myRef.set(true);
    myRef.onDisconnect().remove();
    // Vigilar al rival con periodo de gracia para reconexión (#5)
    this._oppPresRef = this.ref.child('presence/'+oppKey);
    this._oppSeen = false;
    this._graceTimer = null;
    this._oppPresRef.on('value', s=>{
      const present = s.val();
      if(present){
        this._oppSeen = true;
        // Si volvió durante la gracia, cancelar el abandono
        if(this._graceTimer){
          clearTimeout(this._graceTimer); this._graceTimer=null;
          if(this.onOpponentBack) this.onOpponentBack();
        }
        return;
      }
      // Rival ausente: dar unos segundos por si reconecta
      if(this._oppSeen && !this._graceTimer){
        if(this.onOpponentWaiting) this.onOpponentWaiting();
        this._graceTimer = setTimeout(()=>{
          this._graceTimer=null;
          if(this._oppPresRef) this._oppPresRef.off();
          if(this.onOpponentLeft) this.onOpponentLeft();
        }, 6000);   // 6s de gracia
      }
    });
  },
  onOpponentWaiting: null,  // rival se cayó, esperando reconexión
  onOpponentBack: null,     // rival volvió dentro del periodo de gracia

  stopPresence(){
    try {
      if(this._graceTimer){ clearTimeout(this._graceTimer); this._graceTimer=null; }
      if(this._oppPresRef) this._oppPresRef.off();
      if(this.ref && this.role){
        this.ref.child('presence/'+this.role).onDisconnect().cancel();
        this.ref.child('presence/'+this.role).remove();
      }
    } catch(e){}
    this._presenceWatch=false; this._oppPresRef=null; this._oppSeen=false;
  },

  // Suelta los listeners de una partida de torneo SIN borrar nada de la sala
  detachMatch(){
    try {
      this.stopPresence();
      this.stopChat();
      if(this._movesRef){ this._movesRef.off(); this._movesRef=null; }
      if(this._duelRef){ this._duelRef.off(); this._duelRef=null; }
      if(this.ref){ this.ref.child('game/board').off(); this.ref.off(); }
    } catch(e){}
    this.ref=null; this.role=null;
    this.onOpponentLeft=null; this.onMovesReady=null; this.onDuelScores=null;
    this.onBoardUpdate=null; this.onStart=null; this.onEject=null;
    this.onOpponentWaiting=null; this.onOpponentBack=null;
  },

  leave(){
    try {
      this.stopPresence();
      this.stopChat();
      if(this._movesRef){ this._movesRef.off(); this._movesRef=null; }
      if(this._duelRef){ this._duelRef.off(); this._duelRef=null; }
      if(this.ref){
        this.ref.child('game/board').off();
        this.ref.child('guest').off();
        this.ref.off();
        // El host borra la sala entera; el invitado solo se quita
        if(this.role==='host') this.ref.remove();
        else if(this.role==='guest') this.ref.child('guest').remove();
      }
    } catch(e){ console.warn('[Rally] Net.leave', e); }
    this.ref=null; this.code=null; this.role=null; this.onReady=null;
    this.onOpponentLeft=null; this.onMovesReady=null; this.onDuelScores=null;
    this.onBoardUpdate=null; this.onStart=null; this.onEject=null;
  },
};

