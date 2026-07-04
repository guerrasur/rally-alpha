const VERSION = 'v0.2.94';
const firebaseConfig = {
  apiKey: "AIzaSyCQIqu3L7EAClpM1T-yOWkf0AST6GiT278",
  authDomain: "rallye-online.firebaseapp.com",
  databaseURL: "https://rallye-online-default-rtdb.firebaseio.com",
  projectId: "rallye-online",
  storageBucket: "rallye-online.firebasestorage.app",
  messagingSenderId: "88354632994",
  appId: "1:88354632994:web:7a23113ece01bbd55fa17b",
};
const HAS_FIREBASE = !!(window.firebase && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_"));
const DEMO = !HAS_FIREBASE;
let fbApp = null, fbDb = null;
if(HAS_FIREBASE){
  try {
    fbApp = firebase.initializeApp(firebaseConfig);
    fbDb = firebase.database();
    console.log('[Rally] Firebase conectado:', firebaseConfig.projectId);
  } catch(e){
    console.error('[Rally] Error iniciando Firebase:', e);
  }
}

// ===== Auth anónima (v0.2.78) =====
// Las reglas de la DB exigen estar autenticado; el login anónimo es invisible
// para el jugador y persiste entre visitas (mismo uid). Único punto de entrada
// de auth: cuando haya login real, la cuenta anónima se linkea con
// linkWithCredential conservando el uid — solo habría que cambiar esta función.
let _authPromise = null;
let _authSettled = false;   // ya se conoció el primer estado de auth (restauración lista)
function ensureAuth(){
  if(DEMO || !fbDb || !firebase.auth) return Promise.resolve(null);
  const cur = firebase.auth().currentUser;
  if(cur) return Promise.resolve(cur);
  if(!_authPromise){
    const anon = ()=> firebase.auth().signInAnonymously().then(cred => cred.user);
    // Al cargar la página, currentUser es null hasta que Firebase RESTAURA la
    // sesión guardada (asíncrono, puede tardar segundos en un celu). Entrar
    // anónimo en esa ventana PISA la sesión del usuario logueado (#23) — hay
    // que esperar el primer onAuthStateChanged antes de decidir.
    _authPromise = (_authSettled ? anon()
      : new Promise((resolve, reject)=>{
          const unsub = firebase.auth().onAuthStateChanged(u=>{
            unsub();
            if(u) resolve(u); else anon().then(resolve, reject);
          });
        })
    ).catch(e => {
      _authPromise = null;   // permite reintentar en el próximo intento online
      console.error('[Rally] Auth falló:', e);
      throw e;
    });
  }
  return _authPromise;
}

// ===== 👤 Usuario (v0.2.79) =====
// El usuario es la identidad permanente (única, global, en minúscula), distinta
// del nickname que se elige por partida. Se reclama una sola vez en
// usernames/{usuario} → auth.uid (transacción: nadie puede pisarlo) y se
// cachea en localStorage. En el HUD aparece abajo del nickname, chico y gris.
// Contraseña (v0.2.80): Firebase Auth solo maneja email+contraseña, así que el
// usuario se mapea a un email sintético usuario@MAIL_SUFFIX. La contraseña se
// LINKEA a la cuenta anónima (mismo uid → conserva usuario y datos) y permite
// iniciar sesión desde cualquier dispositivo. Sin recupero de contraseña por
// ahora (no hay email real).
const User = {
  name: null,
  RE: /^[a-z0-9_]{3,15}$/,
  MAIL_SUFFIX: '@user.rallye-online.app',
  mail(u){ return u + this.MAIL_SUFFIX; },
  load(){
    try{ this.name = localStorage.getItem('rally_user') || null; }catch(e){}
    this.updateUI();
  },
  set(u){
    this.name = u;
    try{ localStorage.setItem('rally_user', u); }catch(e){}
    this.updateUI();
  },
  normalize(raw){ return String(raw||'').trim().toLowerCase(); },
  current(){ return (HAS_FIREBASE && firebase.auth) ? firebase.auth().currentUser : null; },
  hasPassword(){ const cu=this.current(); return !!(cu && !cu.isAnonymous); },

  // Reclama el usuario para un uid (transacción; tolera que ya sea propio)
  async claim(u, uid){
    try{
      const res = await fbDb.ref('usernames/'+u).transaction(cur=>{
        if(cur === null) return uid;
        return;   // ya existe → abortar
      });
      if(!res.committed){
        if(res.snapshot && res.snapshot.val() === uid) return { ok:true };
        return { ok:false, reason:'ocupado' };
      }
      return { ok:true };
    }catch(e){
      console.error('[Rally] Error reclamando usuario:', e);
      return { ok:false, reason:'sin-conexion' };
    }
  },

  // Registro: usuario + contraseña en un paso (reclama y linkea al uid anónimo)
  async register(raw, pass){
    const u = this.normalize(raw);
    if(!this.RE.test(u)) return { ok:false, reason:'formato' };
    if(!pass || pass.length < 6) return { ok:false, reason:'pass-corta' };
    if(DEMO || !fbDb) return { ok:false, reason:'sin-conexion' };
    let me;
    try{ me = await ensureAuth(); }catch(e){ return { ok:false, reason:'sin-conexion' }; }
    if(!me) return { ok:false, reason:'sin-conexion' };
    if(!me.isAnonymous) return { ok:false, reason:'ya-logueado' };
    const claim = await this.claim(u, me.uid);
    if(!claim.ok) return claim;
    try{
      const cred = firebase.auth.EmailAuthProvider.credential(this.mail(u), pass);
      await me.linkWithCredential(cred);
    }catch(e){
      console.error('[Rally] Error linkeando contraseña:', e);
      return { ok:false, reason: (e && e.code==='auth/weak-password') ? 'pass-corta' : 'sin-conexion' };
    }
    fbDb.ref('users/'+me.uid+'/username').set(u).catch(()=>{});
    this.set(u);
    return { ok:true };
  },

  // Agregar contraseña a un usuario ya creado sin ella (v0.2.79)
  async addPassword(pass){
    if(!this.name) return { ok:false, reason:'sin-usuario' };
    if(!pass || pass.length < 6) return { ok:false, reason:'pass-corta' };
    if(DEMO || !fbDb) return { ok:false, reason:'sin-conexion' };
    const cu = this.current();
    if(!cu) return { ok:false, reason:'sin-conexion' };
    if(!cu.isAnonymous) return { ok:true };   // ya tenía credencial
    try{
      // El usuario local tiene que ser realmente de esta sesión
      const owner = (await fbDb.ref('usernames/'+this.name).get()).val();
      if(owner !== cu.uid) return { ok:false, reason:'sin-conexion' };
      const cred = firebase.auth.EmailAuthProvider.credential(this.mail(this.name), pass);
      await cu.linkWithCredential(cred);
      fbDb.ref('users/'+cu.uid+'/username').set(this.name).catch(()=>{});
      return { ok:true };
    }catch(e){
      console.error('[Rally] Error creando contraseña:', e);
      return { ok:false, reason: (e && e.code==='auth/weak-password') ? 'pass-corta' : 'sin-conexion' };
    }
  },

  // Iniciar sesión con usuario + contraseña (p.ej. en otro dispositivo)
  async login(raw, pass){
    const u = this.normalize(raw);
    if(!this.RE.test(u) || !pass) return { ok:false, reason:'credenciales' };
    if(DEMO || !fbDb || !firebase.auth) return { ok:false, reason:'sin-conexion' };
    try{
      const cred = await firebase.auth().signInWithEmailAndPassword(this.mail(u), pass);
      _authPromise = Promise.resolve(cred.user);
      let confirmed = u;
      try{ confirmed = (await fbDb.ref('users/'+cred.user.uid+'/username').get()).val() || u; }catch(e){}
      this.set(confirmed);
      return { ok:true };
    }catch(e){
      const code = (e && e.code) || '';
      if(/user-not-found|wrong-password|invalid-credential|invalid-login-credentials/.test(code))
        return { ok:false, reason:'credenciales' };
      console.error('[Rally] Error de login:', e);
      return { ok:false, reason:'sin-conexion' };
    }
  },

  // Cerrar sesión. Un usuario SIN contraseña no puede cerrarla (lo perdería
  // para siempre: la cuenta anónima no se puede recuperar).
  async logout(){
    const cu = this.current();
    if(cu && cu.isAnonymous && this.name) return { ok:false, reason:'sin-pass' };
    try{ if(HAS_FIREBASE && firebase.auth) await firebase.auth().signOut(); }catch(e){}
    _authPromise = null;   // el próximo online vuelve a entrar anónimo
    this.name = null;
    try{ localStorage.removeItem('rally_user'); }catch(e){}
    this.updateUI();
    return { ok:true };
  },
  updateUI(){
    // El botón es un ícono (top-controls, junto al tema) — no tocar su SVG.
    const btn = $('btn-user');
    if(btn){
      btn.title = this.name ? ('Usuario: '+this.name) : 'Crear usuario';
      btn.classList.toggle('has-user', !!this.name);
    }
    const foot = $('home-foot');
    if(foot){
      const base = DEMO ? 'Modo práctica activo. Conectá Firebase para jugar online con un amigo.'
                        : 'Online activo · creá una sala y pasá el código.';
      foot.textContent = this.name ? ('👤 '+this.name+' · '+base) : base;
    }
  },
};

// ===== 📊 Estadísticas de jugador (online, v0.2.84) =====
// Se acumulan SOLO en partidas online (salas 1v1 y torneo x4) — la práctica
// offline y el torneo offline no cuentan. Viven en users/{uid}/stats (mismo
// nodo reservado para perfil). Escritura vía transaction() para que sumar
// desde duelos/partidas seguidas no pise valores por una carrera de escrituras.
const Stats = {
  bump(uid, key, delta){
    if(!fbDb || !uid || !delta) return;
    fbDb.ref('users/'+uid+'/stats/'+key).transaction(cur=>(cur||0)+delta)
      .catch(e=>console.error('[Rally] Stats.bump falló ('+key+'):', e));
  },
  bumpMany(uid, deltas){
    for(const k in deltas){ if(deltas[k]) this.bump(uid, k, deltas[k]); }
  },
};

// ===== 📈 Visitas del sitio (v0.2.85) =====
// A diferencia de Stats (que solo cuenta partidas online), esto cuenta CADA
// carga de la página, juegue o no online — por eso dispara la auth anónima
// de una vez al cargar (antes solo pasaba al ir online). Es seguro: ensureAuth
// ya espera el primer onAuthStateChanged (fix #23), así que nunca pisa una
// sesión con contraseña ya iniciada. "Visitante único" = mismo uid persistente
// (mismo navegador/dispositivo), aunque nunca cree usuario ni juegue online.
function trackVisit(){
  if(DEMO || !fbDb) return;
  ensureAuth().then(u=>{
    if(!u) return;
    fbDb.ref('siteStats/pageViews').transaction(cur=>(cur||0)+1).catch(()=>{});
    fbDb.ref('siteStats/visitors/'+u.uid).set(true).catch(()=>{});
  }).catch(()=>{});
}
trackVisit();

// Primer estado de auth conocido (y cada cambio): marca la restauración como
// lista para ensureAuth, re-sincroniza el usuario cacheado si hace falta y
// refresca la UI — sin esto, la pantalla pintada antes de que Firebase
// restaure la sesión queda mostrando "sin sesión" para siempre (#23).
if(HAS_FIREBASE && firebase.auth){
  firebase.auth().onAuthStateChanged(u=>{
    _authSettled = true;
    if(u && !u.isAnonymous && !User.name && fbDb){
      // Sesión viva pero caché local perdida: recuperar el usuario de la DB
      fbDb.ref('users/'+u.uid+'/username').get()
        .then(s=>{ const n=s.val(); if(n && !User.name) User.set(n); })
        .catch(()=>{});
    }
    User.updateUI();
    // Si el overlay de cuenta está abierto, repintarlo con el estado real
    const ov = $('user-overlay');
    if(ov && !ov.hidden && typeof UserUI!=='undefined') UserUI.render();
  });
}

const App = {
  screen: 'home',
  playerName: 'Jugador',
  oppName: 'CPU',
  oppUser: null,    // usuario permanente del rival (solo online), va abajo del nickname
  roomCode: null,
  online: false,
  muted: false,
  isHost: false,
  matchMode: 'single',   // 'single' | 'bo5'
  scoreYou: 0,           // rondas ganadas (bo5)
  scoreOpp: 0,
  wallsMode: false,      // Modo Paredes (experimental)
};

// Entra/sale de modos con tablero especial (ajusta el tamaño global).
function enterWallsMode(){ App.wallsMode = true;  CFG.boardSize = CFG.wallsBoardSize; }
function exitSpecialMode(){ App.wallsMode = false; CFG.boardSize = CFG.boardSizeDefault; Walls.clear(); }
const BO5_TARGET = 3;    // gana quien llega a 3 rondas

// ---- Modo Torneo offline ----
// 8 rivales: vida exponencial 10→200, IA exponencialmente más fuerte (skill 0→1).
// `accent` da el detalle cosmético (color del rival en tablero/HUD).
const TOURNEY_ROSTER = [
  { name:'Maurice',     accent:'#2B8C4E', emoji:'🐒', tag:'CPU' },
  { name:'Mort',        accent:'#D6A22B', emoji:'🐭', tag:'CPU' },
  { name:'Clover',      accent:'#1FA8A0', emoji:'🛡️', tag:'CPU' },
  { name:'Skipper',     accent:'#5A6B7A', emoji:'🐧', tag:'CPU' },
  { name:'Kowalski',    accent:'#7A3BD6', emoji:'📐', tag:'CPU' },
  { name:'Marlene',     accent:'#D6577A', emoji:'🦦', tag:'CPU', trait:'doubleStep' },
  { name:'Alex',        accent:'#D6772B', emoji:'🦁', tag:'CPU', trait:'hardHit' },
  { name:'Rey Julian',  accent:'#C8302B', emoji:'👑', tag:'CPU', trait:'luck' },
];
function currentTrait(){
  return (Tourney.active && TOURNEY_ROSTER[Tourney.index].trait) || null;
}
const Tourney = { active:false, index:0 };
function tourneyHpFor(i){
  // Exponencial 10 → 200 a lo largo de la ronda (n = roster length)
  const n = TOURNEY_ROSTER.length;
  const t = n>1 ? i/(n-1) : 1;
  return Math.round(10 * Math.pow(200/10, t)); // 10,~15,...,200
}
function tourneySkillFor(i){
  // Exponencial 0 → 1: rivales iniciales casi random, finales casi óptimos
  const n = TOURNEY_ROSTER.length;
  const t = n>1 ? i/(n-1) : 1;
  return Math.pow(t, 1.6); // curva que arranca suave y sube fuerte al final
}

// ---- Modo Campaña offline ----
// Historia guiada por "nodos". CAMPAIGN_SCRIPT es la cinta de la campaña: se
// recorre en orden y el progreso (índice de nodo + flags de historia) se
// cachea en localStorage, así el jugador siempre retoma exactamente donde iba
// ("Continuar campaña"). La campaña se irá escribiendo de a poco: para sumar
// contenido alcanza con agregar nodos al final de CAMPAIGN_SCRIPT.
//
// Tipos de nodo soportados hoy (extensible vía Campaign.handlers):
//   { id, type:'match', opp:{ name, hp, skill, accent, emoji, dmgMult }, youHp? }
//       → una partida en el tablero contra ese rival. Se ve como una partida
//         normal; opp permite ir torciendo las reglas sin que se note.
//   { id, type:'scene', lines:['…','…'] }
//       → escena de texto sobre fondo plano, las líneas aparecen de a una.
// Para futuras mecánicas (animaciones, juegos internos, etc.) se registra un
// handler nuevo: Campaign.handlers.miTipo = (node)=>{ …; Campaign.advance(); }
// El handler es dueño de la pantalla y llama Campaign.advance() al terminar.
const CAMPAIGN_SAVE_KEY = 'rally_campaign_v1';
const CAMPAIGN_SCRIPT = [
  // Nodo 0: arranca como una partida rápida normal. Sin nada raro… por ahora.
  { id:'intro-match', type:'match', opp:{ name:'Tarata', hp:11, skill:0.35 } },
  // ← próximos nodos de la campaña van acá (escenas, partidas con mecánicas
  //    nuevas, giros de historia). Ejemplo:
  // { id:'s1', type:'scene', lines:['Cachito te mira fijo.', 'Algo cambió.'] },
];

const Campaign = {
  active:false,   // true mientras el jugador está DENTRO de la campaña
  node:0,         // índice del nodo actual en CAMPAIGN_SCRIPT
  data:null,      // save: { v, node, name, flags, history, startedAt, updatedAt }

  load(){
    try{ const raw = localStorage.getItem(CAMPAIGN_SAVE_KEY); this.data = raw ? JSON.parse(raw) : null; }
    catch(e){ this.data = null; }
    return this.data;
  },
  save(){
    if(!this.data) return;
    this.data.updatedAt = Date.now();
    try{ localStorage.setItem(CAMPAIGN_SAVE_KEY, JSON.stringify(this.data)); }catch(e){}
  },
  clear(){ this.data=null; try{ localStorage.removeItem(CAMPAIGN_SAVE_KEY); }catch(e){} },
  // Hay progreso real solo si completó al menos un nodo. Empezar la campaña y
  // no ganar nada todavía vuelve a mostrar el menú de inicio, no "Continuar".
  hasProgress(){
    if(this.data===null) this.load();
    return !!(this.data && (this.data.node>0 || (this.data.history && this.data.history.length)));
  },

  // Flags de historia: para que futuros nodos guarden decisiones/estado
  // (ej: Campaign.setFlag('vioLaEscenaX', true)) y persistan en el save.
  setFlag(k,v){ if(this.data){ this.data.flags[k]=v; this.save(); } },
  getFlag(k){ return this.data ? this.data.flags[k] : undefined; },

  begin(){   // campaña nueva desde cero
    this.data = { v:1, node:0, name:App.playerName, flags:{}, history:[], startedAt:Date.now(), updatedAt:Date.now() };
    this.save();
    this.enter(0);
  },
  resume(){  // retoma automáticamente donde iba (cacheado en localStorage)
    this.load();
    if(!this.data){ this.begin(); return; }
    if(this.data.name) App.playerName = this.data.name;
    this.enter(this.data.node || 0);
  },
  enter(i){  // ejecuta el nodo i
    this.active = true;
    this.node = i;
    const node = CAMPAIGN_SCRIPT[i];
    if(!node){ this.toBeContinued(); return; }
    const h = this.handlers[node.type];
    if(h) h(node); else this.advance();   // tipo desconocido: no trabar la cinta
  },
  // Marca el nodo actual como completado y CACHEA el progreso (se llama apenas
  // se gana/termina el nodo, antes de cualquier pantalla intermedia, para que
  // cerrar la app no pierda el avance).
  completeCurrent(){
    const done = CAMPAIGN_SCRIPT[this.node];
    this.node++;
    if(this.data){
      this.data.history.push(done ? (done.id || this.node-1) : this.node-1);
      this.data.node = this.node;
      this.save();
    }
  },
  advance(){ this.completeCurrent(); this.enter(this.node); },
  exitToMenu(){ this.active=false; },   // el progreso queda cacheado

  cur(){ return CAMPAIGN_SCRIPT[this.node] || null; },
  matchOpt(k){
    const n = this.cur();
    return (n && n.type==='match' && n.opp) ? n.opp[k] : undefined;
  },

  // No hay más nodos escritos todavía: cierre suave. NO borra el save — cuando
  // se agreguen nodos nuevos, "Continuar campaña" sigue desde este punto.
  toBeContinued(){
    this.active=false;
    playScene(['Continuará…'], ()=>show('home'));
  },
};

// Handlers por tipo de nodo. Cada uno es dueño del flujo de su pantalla y
// termina llamando a Campaign.advance() (el de match avanza desde endGame).
Campaign.handlers = {
  match(node){
    App.online=false;
    Tourney.active=false;
    App.oppName = (node.opp && node.opp.name) || '???';
    applyOppCosmetic();
    // Directo a la partida, SIN el overlay de instrucciones ("Cómo se juega")
    // y SIN fade-in de pantalla: aparece repentinamente, ya empezada.
    const sg = $('screen-game');
    sg.classList.add('is-instant');
    updateHud(); show('game'); startGame();
    setTimeout(()=>sg.classList.remove('is-instant'), 400);
  },
  scene(node){
    playScene(node.lines || [], ()=>Campaign.advance());
  },
};

// Skill de la CPU según contexto (campaña > torneo > práctica 0.35)
function currentCpuSkill(){
  if(Campaign.active){
    const s = Campaign.matchOpt('skill');
    if(s != null) return s;
  }
  return Tourney.active ? tourneySkillFor(Tourney.index) : 0.35;
}

// ¿Le conviene a la CPU un duelo AHORA? Combina la ventaja de vida, los buffs
// acumulados de ambos (daño+defensa, que se juegan enteros en el duelo) y su
// propia puntería. >0 = buscar el duelo; <0 = evitarlo. Rango aprox. [-1, 1].
function cpuDuelAdvantage(){
  const skill = currentCpuSkill();
  const hpEdge   = (G.opp.hp - G.you.hp) / CFG.maxHp;
  const buffEdge = ((G.opp.buffs.dmg - G.you.buffs.dmg) + (G.opp.buffs.def - G.you.buffs.def)) / 12;
  const aimEdge  = (Math.max(skill, 0.3) - 0.55) * 0.6;
  return hpEdge*0.6 + buffEdge*0.5 + aimEdge;
}

// Reproductor genérico de escenas de texto (fondo plano, líneas de a una).
// Base para las futuras escenas de historia de la campaña.
let _sceneTimers = [];
function playScene(lines, onDone){
  show('scene');
  const box = $('scene-text'); box.innerHTML='';
  const btn = $('scene-continue'); btn.hidden = true;
  _sceneTimers.forEach(clearTimeout); _sceneTimers = [];
  const list = (lines && lines.length) ? lines : [' '];
  list.forEach((ln,i)=>{
    _sceneTimers.push(setTimeout(()=>{
      const p = document.createElement('p');
      p.className='scene-line';
      p.textContent = ln;
      box.appendChild(p);
      if(i === list.length-1) btn.hidden = false;
    }, 500 + i*1500));
  });
  btn.onclick = ()=>{
    _sceneTimers.forEach(clearTimeout); _sceneTimers = [];
    if(onDone) onDone();
  };
}

const $ = id => document.getElementById(id);
function show(screen){
  // Al volver al inicio sin partida activa, restaurar el tablero normal si
  // veníamos de un modo especial (evita arrastrar 9x9 + paredes al modo normal).
  if(screen==='home' && App.wallsMode && !G.running){ exitSpecialMode(); }
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('is-active'));
  $('screen-'+screen).classList.add('is-active');
  App.screen = screen;
  // Los controles superiores (info, tema y usuario) solo se muestran en el inicio.
  const tc = $('top-controls');
  if(tc) tc.classList.toggle('is-hidden', screen !== 'home');
  const ib = $('btn-info');
  if(ib) ib.classList.toggle('is-hidden', screen !== 'home');
}
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
let toastT;
function toast(msg, ms=2600){
  const t = $('toast');
  // escapa el texto y luego reemplaza el marcador {ring} por el mini-anillo
  const esc = escapeHtml(msg);
  t.innerHTML = esc.replace(/\{ring\}/g, '<span class="ring-ic"></span>');
  t.classList.add('is-show');
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('is-show'), ms);
}

// ---- Chat en vivo (solo modos online) ----
// UI plegable dentro de #screen-game. Los mensajes viajan por Net.pushChat /
// Net.listenChat (Firebase). No se monta en offline (G.online === false).
const Chat = {
  unread: 0,
  mount(){
    const w = $('chat-widget'); if(!w) return;
    $('chat-log').innerHTML = '';
    this.unread = 0; this._updateBadge();
    w.classList.remove('is-open');
    w.style.display = 'flex';
    Net.onChatMessage = m => this.receive(m);
    Net.listenChat();
  },
  unmount(){
    const w = $('chat-widget'); if(!w) return;
    w.classList.remove('is-open');
    w.style.display = 'none';
    $('chat-log').innerHTML = '';
    this.unread = 0; this._updateBadge();
  },
  send(){
    const inp = $('chat-input'); if(!inp) return;
    const text = inp.value.trim();
    if(!text) return;
    // Sin echo local: el propio mensaje vuelve por child_added (evita duplicado).
    Net.pushChat(text).catch(e=>console.error('[chat] push', e));
    inp.value = '';
  },
  receive(m){
    const log = $('chat-log'); if(!log || !m) return;
    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.from===Net.role ? ' is-mine' : '');
    const nm = document.createElement('span'); nm.className='chat-msg__name'; nm.textContent = m.name || 'Rival';
    const tx = document.createElement('span'); tx.className='chat-msg__text'; tx.textContent = m.text || '';
    row.appendChild(nm); row.appendChild(tx);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    const w = $('chat-widget');
    if(w && !w.classList.contains('is-open')){ this.unread++; this._updateBadge(); }
  },
  toggle(){
    const w = $('chat-widget'); if(!w) return;
    const open = w.classList.toggle('is-open');
    if(open){
      this.unread = 0; this._updateBadge();
      const inp = $('chat-input'); if(inp) inp.focus();
      const log = $('chat-log'); if(log) log.scrollTop = log.scrollHeight;
    }
  },
  _updateBadge(){
    const b = $('chat-badge'); if(!b) return;
    if(this.unread>0){ b.textContent = this.unread>9 ? '9+' : String(this.unread); b.hidden = false; }
    else { b.hidden = true; }
  },
};
function genCode(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c=''; for(let i=0;i<4;i++) c+=A[Math.floor(Math.random()*A.length)];
  return c;
}

const Sound = {
  ctx:null,
  ensure(){ if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } },
  blip(freq=440, dur=0.05, vol=0.04, type='sine'){
    if(App.muted) return; this.ensure(); if(!this.ctx) return;
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type=type; o.frequency.value=freq;
    g.gain.value=vol; o.connect(g); g.connect(this.ctx.destination);
    const t=this.ctx.currentTime; o.start(t);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.stop(t+dur);
  },
  click(){ this.blip(480,0.04,0.04); },
  step(){ this.blip(340,0.03,0.03, 'triangle'); },
  pickupAtk(){ this.blip(760,0.08,0.05, 'triangle'); },
  pickupDef(){ this.blip(580,0.08,0.05, 'sine'); },
  trap(){ this.blip(180,0.15,0.06, 'sawtooth'); },
  countdown(){ this.blip(680,0.08,0.05); },
  duelStart(){ this.blip(440,0.12,0.05, 'triangle'); },
  stop(){ this.blip(820,0.06,0.06); },
  win(){ this.blip(660,0.15,0.05, 'triangle'); },
  lose(){ this.blip(220,0.2,0.05, 'sawtooth'); },
  tie(){ this.blip(400,0.15,0.04); },
  eject(){ this.blip(300,0.10,0.04, 'sawtooth'); },
  regen(){ this.blip(520,0.06,0.03, 'sine'); },
};
function haptic(ms){ if(navigator.vibrate && !App.muted){ try{ navigator.vibrate(ms); }catch(e){} } }

const CFG = {
  boardSize: 7,
  boardSizeDefault: 7,   // tamaño normal (para restaurar al salir de modos especiales)
  wallsBoardSize: 9,     // tamaño del mapa en Modo Paredes
  wallsCount: 14,        // cantidad de segmentos de pared a generar
  maxHp: 100,
  powerDmgCount: 3,
  powerDefCount: 3,
  powerDmgValue: 3,    // antes 2. Partidas se hacían largas: más punch por ítem de ataque.
  powerDefValue: 1,    // antes 2. Defensa achicada para no alargar tanto los duelos.
  downCount: 4,
  downDamage: 10,
  maxPowerDmg: 4,       // techo de buff total: 4×3=12.
  maxPowerDef: 4,       // techo de buff total: 4×1=4.
  regenInterval: 4,
  ejectMinDist: 4,
  ejectMaxDist: 6,
  duelGreenStart:  0.46,
  duelGreenEnd:    0.54,
  duelYellowStart: 0.40,
  duelYellowEnd:   0.60,
  duelOrangeStart: 0.35,
  duelOrangeEnd:   0.65,
  duelOrange2Start: 0.25,   // naranja-interno (dentro del rojo): vale poco pero salva del rojo
  duelOrange2End:   0.75,
  duelPerfectStart: 0.487,  // hitbox agrandado (~doble), la línea visual sigue en 0.50
  duelPerfectEnd:   0.513,
  perfectScore: 20,
  greenScore: 10,
  yellowScore: 6,
  orangeScore: 4,
  orange2Score: 3,          // naranja-interno
  redBaseScore: 2,          // rojo real más débil (antes 3)
  redMinScore: 1,
  duelMaxPasses: 4,
  ringChancePerTurn: 0.06,   // prob. por turno (solo pasada la mitad) de que aparezca
  ringMinTurn: 8,            // antes de este turno no aparece (partida avanzada)
  ringBigHeal: 50,           // cura grande si cumple condiciones
  ringHealDiff: 20,          // diferencia de HP requerida
  ringHealUnder: 40,         // HP máximo del que lo agarra para la cura grande
  ringDripHeal: 5,           // cura por ronda si no cumple
  ringDripRounds: 5,         // cantidad de rondas de cura chica
  duelCountdownMs: 800,
  duelCycleDuration: 1.8,
  cpuDesperateTrapRatio: 0.6,
  cpuDesperateHpMin: 30,
};
// ---- Diseño del duelo: minijuego vs. daño ----
// El puntaje crudo del minijuego (0-20, ver computeScore) decide QUIÉN gana el
// duelo — es independiente de los buffs. Los buffs solo escalan el DAÑO que el
// ganador aplica al HP del rival (ver computeDuelDamages/duelDamage). "Perfecto"
// sigue anulando ataque+defensa del rival cuando solo uno lo saca.
//
// ---- Rebalance de stats (ítems/duelo) ----
// Objetivo: duelos ni instantáneos ni eternos, y buffs que se sientan pero no decidan solos.
//   maxHp, downDamage: sin cambios (100 / 10, se probó 120/12 y se revirtió).
//   powerDmgValue  3 → 2 → 3  (2 achicaba demasiado el impacto de un ítem; se subió
//                              de nuevo a 3 porque las partidas se estaban alargando)
//   powerDefValue  3 → 2 → 1  (misma razón: defensa se achicó más que el ataque para
//                              acortar partidas, ya no decide quién gana el duelo)
//   maxPowerDmg    6 → 4  (techo de buff total: 4×3=12, antes 6×3=18)
//   maxPowerDef    6 → 4  (techo de buff total: 4×1=4, antes 6×3=18)

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
      const bothHere = youHere && oppHere;
      if(bothHere) div.classList.add('is-both-here');
      if(youHere){
        const m=document.createElement('div'); m.className='player-marker is-you';
        if(shielded) m.classList.add('has-shield');
        if(G.skinYou){ m.classList.add('has-skin'); m.textContent=G.skinYou; }
        if(bothHere) m.classList.add('is-clash');
        div.appendChild(m);
      }
      if(oppHere){
        const m=document.createElement('div'); m.className='player-marker is-opp';
        if(shielded) m.classList.add('has-shield');
        if(G.skinOpp){ m.classList.add('has-skin'); m.textContent=G.skinOpp; }
        if(bothHere) m.classList.add('is-clash');
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

// Globos "Vos"/rival al arrancar la partida: se llama UNA sola vez, justo
// después del primer renderBoard() de startGame()/startOnlineGame() — nunca
// desde adentro de renderBoard() mismo (si no, reaparecerían en cada
// movimiento, ya que esa función se llama muchas veces durante la partida).
function showStartBubbles(){
  // "Rival" genérico solo en práctica rápida/demo y Campaña; en torneo
  // offline, online 1v1 y torneo online x4 (rival humano o CPU de relleno)
  // se muestra el nombre real (App.oppName ya lo trae siempre bien puesto).
  const showGenericRival = Campaign.active || (!G.online && !Tourney.active && !OT.active);
  spawnStartBubble('.player-marker.is-you', 'Vos', 'is-you');
  spawnStartBubble('.player-marker.is-opp', showGenericRival ? 'Rival' : App.oppName, 'is-opp');
}
function spawnStartBubble(selector, text, cls){
  const piece = document.querySelector(selector);
  const wrap = document.querySelector('.board-wrap');
  if(!piece || !wrap) return;
  const pr = piece.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = 'start-bubble ' + cls;
  b.textContent = text;
  b.style.left = (pr.left - wr.left + pr.width/2) + 'px';
  b.style.top = (pr.top - wr.top) + 'px';
  wrap.appendChild(b);
  requestAnimationFrame(()=>b.classList.add('is-show'));
  setTimeout(()=>{
    b.classList.add('is-gone');
    setTimeout(()=>b.remove(), 350);
  }, 1000);
}

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
  showStartBubbles();
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
  showStartBubbles();
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

  // Ventaja de duelo (HP + buffs + puntería): gobierna acercarse o huir.
  // Durante la tregua post-duelo no hay duelo posible → no influye ese turno.
  const adv = G.justDueled ? 0 : cpuDuelAdvantage();

  // Ítem objetivo: el más valioso del tablero, descontado por distancia desde
  // la CPU. Cada casilla candidata que acorte camino hacia él suma (gradiente):
  // atrae hacia ítems a 3-4 casillas sin búsqueda de caminos.
  let targetItem = null;
  if(skill > 0.25){
    let bestVal = 0;
    for(let ty=0; ty<n; ty++) for(let tx=0; tx<n; tx++){
      const t = cellAt(tx,ty).type;
      let val = 0;
      if(t==='power_dmg') val = 6;
      else if(t==='power_def') val = 5;
      else if(t==='ring') val = 7 + ((CFG.maxHp - G.opp.hp)/CFG.maxHp)*8;
      if(!val) continue;
      const d = Math.max(Math.abs(tx-G.opp.x), Math.abs(ty-G.opp.y));
      const discounted = val - d * 1.2;
      if(discounted > bestVal){ bestVal = discounted; targetItem = {x:tx, y:ty, val}; }
    }
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
      // Excepción 3: casi acorralada y con la mayoría de salidas con trampa —
      // mejor comerse una cruz que quedar encerrada el turno siguiente.
      else if(almostBoxed && (nonTrap.length / reachable.length) < CFG.cpuDesperateTrapRatio){
        score += 7;   // neto −7: la mitad del castigo normal
      }
      // En cualquier otro caso, la cruz queda muy negativa → la evita.
    }

    if(cell.type !== 'down'){
      // Buscar o evitar el duelo según la ventaja REAL (HP + buffs + puntería),
      // usando la posición actual del jugador como predicción (mov. simultáneo).
      const dist = Math.max(Math.abs(p.x - G.you.x), Math.abs(p.y - G.you.y));
      if(dist <= 1)      score += adv * (4 + skill * 4);   // casilla de duelo casi seguro
      else if(dist === 2) score += adv * (2 + skill * 2);  // zona de riesgo
      if(adv < -0.15)     score += Math.min(dist, 4) * 0.6; // en desventaja: premiar distancia

      // Gradiente hacia el ítem objetivo: cada casilla que acorte camino suma.
      if(targetItem){
        const d = Math.max(Math.abs(p.x - targetItem.x), Math.abs(p.y - targetItem.y));
        score += Math.max(0, targetItem.val - d * 1.2) * skill * 0.5;
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
        score -= 8 / recency;          // penalización por reciente
        score -= (visits - 1) * 5;     // extra por cada repetición → castiga ciclos
      }
    }

    score += Math.random() * noise;
    return { ...p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Salvaguarda dura anti-trabazón (#17): si la mejor opción es una casilla ya
  // visitada 2+ veces en el historial reciente, forzar una alternativa. Antes
  // solo saltaba a una casilla "fresca" (no visitada) y si no había ninguna
  // fallaba en silencio → el ciclo persistía. Ahora, sin frescas, cae a la
  // no-trampa MENOS visitada (desempate por score, ya vienen ordenadas).
  if(!G.online && G.opp.history && G.opp.history.length>=4){
    const h = G.opp.history;
    const visitsOf = (p)=> h.filter(k=>k===`${p.x},${p.y}`).length;

    // Detector de ciclo exacto A,B,A,B: si la elegida vuelve al ping-pong,
    // forzar la mejor opción fuera de {A,B} aunque el score no la favorezca.
    const last4 = h.slice(-4);
    const isPingPong = last4.length===4 && last4[0]===last4[2] &&
                       last4[1]===last4[3] && last4[0]!==last4[1];
    if(isPingPong){
      const bestKey = `${scored[0].x},${scored[0].y}`;
      if(bestKey===last4[0] || bestKey===last4[1]){
        const out = scored.find(p=>{
          const k=`${p.x},${p.y}`;
          return k!==last4[0] && k!==last4[1] && cellAt(p.x,p.y).type!=='down';
        });
        if(out) return { x: out.x, y: out.y };
      }
    }

    const bestVisits = visitsOf(scored[0]);
    if(bestVisits>=2){
      const nonTrapScored = scored.filter(p=>cellAt(p.x,p.y).type!=='down');
      const fresh = nonTrapScored.filter(p=>visitsOf(p)===0);
      if(fresh.length) return { x: fresh[0].x, y: fresh[0].y };
      if(nonTrapScored.length){
        // Sin casillas frescas: la menos pisada rompe el ciclo igual.
        let least = nonTrapScored[0];
        for(const p of nonTrapScored){ if(visitsOf(p) < visitsOf(least)) least = p; }
        return { x: least.x, y: least.y };
      }
    }
  }

  return { x: scored[0].x, y: scored[0].y };
}

// Desplazamiento fluido de casilla a casilla (FLIP: medir antes de redibujar,
// dejar que renderBoard() salte a la posición nueva, invertir la diferencia
// con un transform sin transición y soltarlo un frame después — .player-marker
// ya trae su propia transition de transform, así que el navegador anima solo).
// Sirve igual para ortogonal o diagonal (delta 2D genérico).
function getMarkerRect(cls){
  const el = document.querySelector('.player-marker.'+cls);
  return el ? el.getBoundingClientRect() : null;
}
function flipMarker(cls, oldRect){
  if(!oldRect) return;
  const el = document.querySelector('.player-marker.'+cls);
  if(!el) return;
  const newRect = el.getBoundingClientRect();
  const dx = oldRect.left - newRect.left, dy = oldRect.top - newRect.top;
  if(!dx && !dy) return;
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      // Curva propia para el deslizamiento (carga y llegada, sin rebote):
      // la de .player-marker en CSS es "back-out" (se usa para el pop de
      // choque, .is-clash) y pasa de largo antes de asentar. Al terminar,
      // se limpia la transition inline para no pisar esa otra animación.
      el.style.transition = 'transform .35s ease-in-out';
      el.style.transform = '';
      el.addEventListener('transitionend', ()=>{ el.style.transition = ''; }, {once:true});
    });
  });
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
  // Si ambos caen en la MISMA casilla, renderBoard() les aplica su propio
  // transform de choque (.is-clash) — no animamos ese caso puntual para no
  // pelear con ese offset ya afinado.
  const willClash = (G.yourMove.x===G.oppMove.x && G.yourMove.y===G.oppMove.y);
  const youOldRect = willClash ? null : getMarkerRect('is-you');
  const oppOldRect = willClash ? null : getMarkerRect('is-opp');
  G.you.x=G.yourMove.x; G.you.y=G.yourMove.y; G.opp.x=G.oppMove.x; G.opp.y=G.oppMove.y;
  const sharedBuff = applySharedCellEffects();
  applyRingDrip(G.you); applyRingDrip(G.opp);
  // La tregua se cumple en cuanto ambos se mueven: quitar la burbuja YA,
  // antes de redibujar, para que no quede un instante en la casilla nueva.
  const wasTruce = G.justDueled;
  G.justDueled = false;
  Sound.step(); haptic(10); renderBoard(); updateHud();
  flipMarker('is-you', youOldRect);
  flipMarker('is-opp', oppOldRect);
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
    const proceed = ()=>{
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
    };
    // Ambos cayeron en la MISMA casilla con un ítem: ruleta rápida que muestra
    // quién se lo llevó (el sorteo ya está decidido), y recién después sigue el
    // flujo normal (duelo si no había tregua; nada más si la había).
    if(sharedBuff){ showBuffRoulette(sharedBuff, proceed); }
    else proceed();
  }, 550);
}

// Ruleta rápida de buff compartido: alterna el resaltado entre los dos nombres
// cada vez más lento y clava el ganador. Solo visual (el ganador ya se aplicó
// en applySharedCellEffects). Dura ~1.5s en total, después llama a done().
function showBuffRoulette(info, done){
  const ov=$('roulette-overlay');
  if(!ov){ done(); return; }
  $('roulette-item').textContent=info.itemEmoji;
  const nYou=$('roulette-name-you'), nOpp=$('roulette-name-opp');
  nYou.textContent=App.playerName; nOpp.textContent=App.oppName;
  nYou.classList.remove('is-on','is-winner'); nOpp.classList.remove('is-on','is-winner');
  ov.style.display='flex';
  // Delays crecientes: total ~1030ms de giro + 450ms mostrando al ganador.
  // Cantidad IMPAR de pasos: el primero y el último caen del mismo lado, así
  // arrancando por el ganador se garantiza que el resaltado final es el correcto.
  const delays=[90,90,110,130,160,200,250];
  let i=0;
  const step=()=>{
    if(i>=delays.length){
      const win = info.youWins ? nYou : nOpp;
      const lose = info.youWins ? nOpp : nYou;
      lose.classList.remove('is-on');
      win.classList.add('is-winner');
      haptic(12);
      setTimeout(()=>{ ov.style.display='none'; done(); }, 450);
      return;
    }
    const onYou = info.youWins ? (i%2===0) : (i%2===1);
    nYou.classList.toggle('is-on', onYou);
    nOpp.classList.toggle('is-on', !onYou);
    Sound.step && Sound.step();
    setTimeout(step, delays[i]);
    i++;
  };
  step();
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
      const itemEmoji = cell.type==='power_dmg' ? '🗡️' : (cell.type==='power_def' ? '◈' : '💍');
      applyCellEffect(winner);                 // solo uno recibe el ítem/anillo
      cell.type='empty';                       // la casilla queda vacía para el otro
      // Devuelve la info para la ruleta visual (el sorteo ya está aplicado)
      return { youWins, itemEmoji };
    }
    if(cell.type==='down'){
      // Trampa compartida: ambos la pisan (ambos reciben el daño)
      applyCellEffect(G.you);
      // la casilla ya se consumió; aplicar daño al otro manualmente
      G.opp.hp = Math.max(1, G.opp.hp - CFG.downDamage);
      return null;
    }
    return null; // casilla vacía
  }
  // Casillas distintas: cada uno la suya, normal
  applyCellEffect(G.you); applyCellEffect(G.opp);
  return null;
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
  // La línea del perfecto solo tiene sentido en el 1er pase (ahí aplica el súper
  // golpe): brilla dorada mientras está activa y se apaga al terminar la ida.
  const mark=$('speedo-center-mark');
  if(mark){
    if(G.duel.pass===1){
      mark.style.display='';
      mark.classList.add('is-live');
      mark.classList.remove('is-gone');
    } else if(mark.classList.contains('is-live')){
      mark.classList.remove('is-live');
      mark.classList.add('is-gone');
      setTimeout(()=>{ mark.classList.remove('is-gone'); mark.style.display='none'; }, 320);
    }
  }
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

  // Estado de la partida: desesperada/perdiendo arriesga el pase 1 (donde vive
  // el PERFECTO) y aprieta la puntería; cómoda juega seguro y algo relajado.
  const desperate  = G.opp.hp <= CFG.cpuDesperateHpMin;
  const losingMatch = G.opp.hp < G.you.hp - 10;
  const comfortable = G.opp.hp > G.you.hp + 20;
  let pass1Prob = 0.6, aimTighten = 1.0;
  if(desperate || losingMatch){ pass1Prob = 0.9; aimTighten = 1 - 0.35*skill; }
  else if(comfortable){ pass1Prob = 0.45; aimTighten = 1.1; }

  // Apunta al centro (verde) de un tramo de subida (pases impares 1, 3).
  const targetPass = (Math.random() < pass1Prob) ? 1 : 3;
  const idealInSweep = half / 2;                     // centro del tramo (verde)

  // Piso de habilidad: ni el rival más débil apunta tan mal como para caer
  // casi siempre en rojo. Mantiene los duelos parejos.
  const aimSkill = Math.max(skill, 0.3);
  // Error con distribución cuasi-gaussiana (promedio de 3 randoms): concentra
  // las frenadas cerca del verde y hace raros los extremos (rojo).
  const gauss = ((Math.random()+Math.random()+Math.random())/3 - 0.5) * 2;
  const aimError = ((1 - aimSkill) * half * 0.28 + 0.03) * aimTighten;
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

  const pos = labForcePerfect ? (CFG.duelPerfectStart + CFG.duelPerfectEnd) / 2 : timeToPosition(G.duel.time);
  const pass = labForcePerfect ? 1 : G.duel.pass;

  G.duel.yourScore=computeScore(pos, pass);
  G.duel.yourStopped=true;
  G.duel.yourStoppedPos=pos;
  G.duel.yourStoppedPass=pass;
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
// Reinicia el resplandor de PERFECTO en cada duelo, incluso si el anterior también lo fue.
function flashPerfectHit(el, on){
  el.classList.remove('is-perfect-hit');
  if(on){ void el.offsetWidth; el.classList.add('is-perfect-hit'); }
}

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
  flashPerfectHit(bYou, youPerfect);
  flashPerfectHit(bOpp, oppPerfect);

  // Quién gana el duelo lo decide SOLO el puntaje crudo del minijuego (0-20),
  // nunca los buffs: eso mantiene el minijuego totalmente independiente.
  // Verdict corto: "GANA {nombre}" con el GANA en verde si ganaste vos y en
  // rojo si ganó el rival. Debajo, los puntajes chicos en gris: "(6v3)".
  const vEl=$('reveal-verdict');
  if(rawYou>rawOpp){
    const sup = youPerfect ? '<b style="color:var(--perfect)">PERFECTO</b> · ' : '';
    vEl.innerHTML=`${sup}<b style="color:var(--good)">GANA</b> ${App.playerName}`;
  } else if(rawOpp>rawYou){
    const sup = oppPerfect ? '<b style="color:var(--perfect)">PERFECTO</b> · ' : '';
    vEl.innerHTML=`${sup}<b style="color:var(--bad)">GANA</b> ${App.oppName}`;
  } else {
    vEl.innerHTML=`<b style="color:var(--warn)">EMPATE</b>`;
  }
  const sEl=$('reveal-scoreline');
  if(sEl) sEl.textContent=`(${rawYou}v${rawOpp})`;

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

// Pantalla de veredicto: título (ganaste/perdiste/empate), aviso de PERFECTO
// si aplica, y dos columnas (vos izquierda, rival derecha) con el daño recibido
// bien grande y la barra de HP animando el descenso desde la vida que tenía
// hasta la que le quedó. El daño mostrado sale del delta real de HP (incluye
// el golpe de vuelta del perdedor automáticamente).
function showDuelOutcome(o){
  // Guarda: si el HTML en caché es viejo y no tiene las columnas nuevas,
  // no explotar acá (dejaría el duelo trabado en el velocímetro).
  if(!$('rescol-dmg-you') || !$('duel-result-sub')) return;
  const titleEl=$('duel-result-title');
  titleEl.classList.remove('is-win','is-lose','is-tie');
  const sub=$('duel-result-sub');
  if(o.tie){
    titleEl.textContent='Empate'; titleEl.classList.add('is-tie');
    sub.textContent='Nadie pierde vida — ambos salen expulsados';
  } else {
    const winName = o.youWin ? App.playerName : App.oppName;
    titleEl.textContent = o.youWin ? 'Ganaste el duelo' : 'Perdiste el duelo';
    titleEl.classList.add(o.youWin ? 'is-win' : 'is-lose');
    sub.textContent = o.perfect ? `⭐ PERFECTO de ${winName}` : '';
  }
  $('rescol-name-you').textContent=App.playerName;
  $('rescol-name-opp').textContent=App.oppName;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Réplica de la barra del HUD: misma escala que updateHud() (el rival puede
  // tener maxHp distinto en campaña/torneo) y mismas clases de color.
  const col=(side, before, after, maxHp)=>{
    const taken=Math.max(0, before-after);
    const dmgEl=$('rescol-dmg-'+side);
    dmgEl.textContent = taken>0 ? `−${taken}` : '0';
    dmgEl.classList.toggle('is-zero', taken===0);
    const numEl=$('rescol-hp-'+side);
    const fill=$('rescol-fill-'+side);
    const pct=(hp)=>Math.max(0, Math.min(100, hp/maxHp*100));
    const setColor=(p)=>{
      fill.classList.toggle('is-low', p<25);
      fill.classList.toggle('is-mid', p>=25 && p<55);
    };
    if(reduceMotion){
      setColor(pct(after));
      fill.style.width=pct(after)+'%';
      numEl.textContent=Math.max(0, after);
      return;
    }
    // La barra arranca en la vida que TENÍA (sin transición, con el color de
    // ese momento) y, ya visible, se vacía animada hasta la vida que le quedó.
    // El número acompaña contando para abajo con el mismo easing.
    setColor(pct(before));
    fill.style.transition='none';
    fill.style.width=pct(before)+'%';
    numEl.textContent=Math.max(0, before);
    setTimeout(()=>{
      fill.style.transition='';
      fill.style.width=pct(after)+'%';
      setColor(pct(after));
      const dur=900, t0=performance.now();
      const ease=(t)=>1-Math.pow(1-t, 3);   // aprox del cubic-bezier de la barra
      const tick=(now)=>{
        const t=Math.min(1,(now-t0)/dur);
        numEl.textContent=Math.max(0, Math.round(before+(after-before)*ease(t)));
        if(t<1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, 500);
  };
  col('you', o.youBefore, G.you.hp, CFG.maxHp);
  col('opp', o.oppBefore, G.opp.hp, G.opp.maxHp || CFG.maxHp);
}

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
  const youHpBefore=G.you.hp, oppHpBefore=G.opp.hp;
  // Quién ganó el duelo lo decide el puntaje crudo del minijuego, no el daño
  // ya modificado por buffs.
  let isTie=false;
  if(rawYou>rawOpp){
    const rawChip=loserChipDamage(oppRealDmg, yourRealDmg);
    const chip=chipWithMercy(G.you.hp, rawChip);   // tiro de gracia: ganar no te mata
    G.opp.hp=Math.max(0,G.opp.hp-yourRealDmg);
    G.you.hp=Math.max(0,G.you.hp-chip);
    showDuelOutcome({ youWin:true, perfect:_dmg.youPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.win(); haptic([15,30,15]);
  } else if(rawOpp>rawYou){
    const rawChip=loserChipDamage(yourRealDmg, oppRealDmg);
    const chip=chipWithMercy(G.opp.hp, rawChip);   // tiro de gracia: el rival ganador no muere por chip
    G.you.hp=Math.max(0,G.you.hp-oppRealDmg);
    G.opp.hp=Math.max(0,G.opp.hp-chip);
    showDuelOutcome({ youWin:false, perfect:_dmg.oppPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.lose(); haptic([20,60,20]);
  } else {
    isTie=true; showDuelOutcome({ tie:true, youBefore:youHpBefore, oppBefore:oppHpBefore }); Sound.tie();
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
  if(OT.active && OT.inMatch && OT.master) OT.pushSpec({ active:true });
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
  const pos = labForcePerfect ? (CFG.duelPerfectStart + CFG.duelPerfectEnd) / 2 : timeToPosition(G.duel.time);
  const score = computeScore(pos, labForcePerfect ? 1 : G.duel.pass);
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

// Se llama tanto al frenar mi aguja (commitMyDuelScore) como al enterarme del
// score del rival por Firebase (onDuelScoresReady) — ambos caminos pueden
// disparar casi simultáneos cuando frenás segundo (ya conocías el score
// rival, y tu propio push recién "rebota" un instante después por la
// escucha). El guard de `_revealShown` asegura que solo el PRIMER trigger
// arranque el paso 1 (revelado); el paso 2 (veredicto) SOLO lo dispara su
// propio setTimeout vía finishDuelOnline — así un segundo trigger externo no
// puede adelantar el veredicto y cortar el revelado a la mitad.
function resolveDuelOnline(){
  if(G._duelResolved) return;     // evitar doble resolución
  if(!(G.duel.yourStopped && G.duel.oppStopped)) return;
  if(G._revealShown) return;      // el paso 1 ya arrancó; su propio setTimeout dispara el paso 2
  G._revealShown=true;
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  G.phase='duel-reveal';
  showDuelReveal();
  setTimeout(finishDuelOnline, 2200);
}

function finishDuelOnline(){
  if(G._duelResolved) return;
  G._duelResolved = true;
  $('duel-reveal').style.display='none';
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  G.phase='duel-result';

  const rawYou=G.duel.yourScore??0, rawOpp=G.duel.oppScore??0;
  const _dmgO=computeDuelDamages();
  const yourRealDmg=_dmgO.yourDmg, oppRealDmg=_dmgO.oppDmg;
  const youHpBefore=G.you.hp, oppHpBefore=G.opp.hp;
  // Quién ganó el duelo lo decide el puntaje crudo del minijuego, no el daño
  // ya modificado por buffs.
  let isTie=false;
  // stats: solo duelos online — ensureAuth() espera a que la sesión (ya en
  // curso) termine de resolverse en vez de asumir currentUser ya disponible
  // (evita perder el guardado si la restauración de sesión todavía no terminó).
  if(rawYou>rawOpp){
    const rawChip=loserChipDamage(oppRealDmg, yourRealDmg);
    const chip=chipWithMercy(G.you.hp, rawChip);   // tiro de gracia: ganar no te mata
    G.opp.hp=Math.max(0,G.opp.hp-yourRealDmg);
    G.you.hp=Math.max(0,G.you.hp-chip);
    ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { damageDealt:yourRealDmg, damageReceived:chip, kills:G.opp.hp<=0?1:0 }); });
    showDuelOutcome({ youWin:true, perfect:_dmgO.youPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.win(); haptic([15,30,15]);
  } else if(rawOpp>rawYou){
    const rawChip=loserChipDamage(yourRealDmg, oppRealDmg);
    const chip=chipWithMercy(G.opp.hp, rawChip);   // tiro de gracia: el rival ganador no muere por chip
    G.you.hp=Math.max(0,G.you.hp-oppRealDmg);
    G.opp.hp=Math.max(0,G.opp.hp-chip);
    ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { damageDealt:chip, damageReceived:oppRealDmg }); });
    showDuelOutcome({ youWin:false, perfect:_dmgO.oppPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.lose(); haptic([20,60,20]);
  } else {
    isTie=true; showDuelOutcome({ tie:true, youBefore:youHpBefore, oppBefore:oppHpBefore }); Sound.tie();
  }
  if(OT.active && OT.inMatch && OT.master){
    const meIsA = (OT.matchA===OT.mySeat);
    const winner = isTie ? 'tie' : ((rawYou>rawOpp)===meIsA ? 'A' : 'B');
    OT.pushSpec({ active:false, winner, scoreA: meIsA?rawYou:rawOpp, scoreB: meIsA?rawOpp:rawYou });
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

function updateHud(){
  const oppMax = G.opp.maxHp || CFG.maxHp;
  const youPct=Math.max(0,Math.min(100,(G.you.hp/CFG.maxHp)*100));
  const oppPct=Math.max(0,Math.min(100,(G.opp.hp/oppMax)*100));
  $('hp-fill-you').style.width=youPct+'%'; $('hp-fill-opp').style.width=oppPct+'%';
  $('hp-num-you').textContent=Math.max(0,G.you.hp); $('hp-num-opp').textContent=Math.max(0,G.opp.hp);
  $('hp-fill-you').classList.toggle('is-low',youPct<25); $('hp-fill-you').classList.toggle('is-mid',youPct>=25&&youPct<55);
  $('hp-fill-opp').classList.toggle('is-low',oppPct<25); $('hp-fill-opp').classList.toggle('is-mid',oppPct>=25&&oppPct<55);
  $('hud-name-you').textContent=App.playerName;
  // Usuario permanente abajo del nickname (chico y gris). El del rival solo online.
  $('hud-user-you').textContent = User.name || '';
  $('hud-user-opp').textContent = (G.online && App.oppUser) ? App.oppUser : '';
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
      ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { gamesPlayed:1, gamesWon: won===true?1:0 }); });
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

// ---- Net: salas online sobre Firebase Realtime Database ----
const Net = {
  ref: null,          // referencia a rooms/{code}
  code: null,
  role: null,         // 'host' | 'guest'
  onReady: null,      // callback cuando ambos jugadores están

  // HOST: crea una sala con código único y espera al invitado
  async createRoom(){
    if(DEMO || !fbDb) return genCode();
    await ensureAuth();
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
      host: { name: App.playerName, user: User.name || null },
      guest: null,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    // Nota: el auto-borrado por desconexión se desactivó para testear con
    // múltiples pestañas. La sala se limpia al salir con Net.leave().

    // Escucha la llegada del invitado (y su partida antes de empezar)
    this._sawGuest = false;
    this.ref.child('guest').on('value', s=>{
      const g = s.val();
      if(g && g.name){
        this._sawGuest = true;
        App.oppName = g.name;
        App.oppUser = g.user || null;
        this.ref.child('status').set('ready');
        if(this.onReady) this.onReady({ role:'host', oppName:g.name });
      } else if(this._sawGuest && !G.running && this.ref){
        // El invitado se fue del lobby (o se le cortó): volver a esperar
        this._sawGuest = false;
        this.ref.child('status').set('waiting');
        if(this.onGuestLeft) this.onGuestLeft();
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
    await ensureAuth();
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
    App.oppUser = (room.host && room.host.user) || null;

    await ref.child('guest').set({ name: App.playerName, user: User.name || null });
    // Si me desconecto antes de que arranque la partida (refresh, pestaña
    // cerrada, celu que mata el navegador), mi lugar se libera solo — si no,
    // la sala queda "llena" para siempre y no se puede reintentar (#22).
    // Al arrancar la partida se cancela (startPresence): ahí ya vigila la
    // presencia con periodo de gracia, y un corte breve no debe borrar nada.
    this._guestSlotRef = ref.child('guest');
    this._guestSlotRef.onDisconnect().remove();

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
    // La partida arrancó: el lugar del guest ya no se libera por desconexión
    // (de eso se encarga la presencia, con gracia de reconexión).
    this.cancelGuestSlotCleanup();
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

  // Cancela el auto-borrado del lugar del guest armado en joinRoom (#22)
  cancelGuestSlotCleanup(){
    if(!this._guestSlotRef) return;
    try{ this._guestSlotRef.onDisconnect().cancel(); }catch(e){}
    this._guestSlotRef = null;
  },

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
      this.cancelGuestSlotCleanup();
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
    App.oppUser = null;
    try {
      this.cancelGuestSlotCleanup();
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
    this.onGuestLeft=null; this._sawGuest=false;
    this.onOpponentLeft=null; this.onMovesReady=null; this.onDuelScores=null;
    this.onBoardUpdate=null; this.onStart=null; this.onEject=null;
  },
};

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
  _champBumped:false,   // evita sumar "torneos ganados" más de una vez por torneo

  resetRunFlags(){
    this.inMatch=false; this.myMatchId=null; this.matchA=null; this.matchB=null;
    this.master=false; this.myDone=false; this.eliminated=false;
    this.finished=false; this._finalHandled=false; this._champBumped=false; this.stopSpec();
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
    const players={ s0:{ name:App.playerName||'Jugador', color:SEAT_COLORS.s0, uid:this.uid, user:User.name||null } };
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
        if(cur===null) return { name:App.playerName||'Jugador', color:SEAT_COLORS[s], uid:OT.uid, user:User.name||null };
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
        const userTxt = p.user ? ` <span class="ot-user">${escHtml(p.user)}</span>` : '';
        row.innerHTML=`<span class="p-dot" style="background:${p.color||CPU_GRAY}"></span><span>${escHtml(p.name)}${userTxt}</span><span class="ot-tag">${tag}</span>`;
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
    this.myDone=false; this.eliminated=false; this.finished=false; this._finalHandled=false; this._champBumped=false;
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
    App.oppUser=opp.user||null;
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
    const wasOnline = G.online;   // se resetea abajo; capturar antes para las stats
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
    if(wasOnline){   // partida vs humano real (no CPU de relleno) → cuenta para stats
      ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { gamesPlayed:1, gamesWon: winner===this.mySeat?1:0 }); });
    }
    if(G.online) Net.detachMatch();
    G.online=false; G.running=false;
    this.inMatch=false; this.myDone=true;
    if(winner!==this.mySeat) this.eliminated=true;
    this.clearColors();
    show('othub'); this.renderHub();
  },

  // ---- Estado para espectadores ----
  // duelInfo (opcional): { active:true } al empezar el duelo, o
  // { active:false, winner:'A'|'B'|'tie', scoreA, scoreB } al resolverse.
  // Es un .set() completo (no merge) — por eso el "aviso de duelo" desaparece
  // solo en el próximo pushSpec() normal (sin duelInfo) de startChoosePhase.
  pushSpec(duelInfo){
    try{
      if(!this.active || !this.ref || !this.myMatchId || !this.master) return;
      let A,B;
      if(this.matchA===this.mySeat){ A=G.you; B=G.opp; } else { A=G.opp; B=G.you; }
      const payload = {
        board: serializeBoard(), turn: G.turnCount,
        A:{ x:A.x, y:A.y, hp:Math.max(0,A.hp) },
        B:{ x:B.x, y:B.y, hp:Math.max(0,B.hp) },
      };
      if(duelInfo) payload.duel = duelInfo;
      this.ref.child('matches/'+this.myMatchId+'/spec').set(payload).catch(()=>{});
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
      if(fw===this.mySeat){
        title.textContent='🏆 Ganaste el torneo'; title.classList.add('is-win');
        if(!this._champBumped){
          this._champBumped = true;
          ensureAuth().then(u=>{ if(u) Stats.bump(u.uid, 'tournamentsWon', 1); });
        }
      }
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
    const st=this._specSeats||{};
    if(spec.duel && spec.duel.active){
      $('spec-note').textContent='⚔️ ¡Duelo en curso!';
    } else if(spec.duel && spec.duel.active===false){
      const pa=this.players[st.a]||{}, pb=this.players[st.b]||{};
      $('spec-note').textContent = (spec.duel.winner==='tie')
        ? `🤝 Empate (${spec.duel.scoreA}-${spec.duel.scoreB})`
        : `⚔️ Ganó ${escHtml((spec.duel.winner==='A'?pa:pb).name||'?')} (${spec.duel.scoreA}-${spec.duel.scoreB})`;
    } else {
      $('spec-note').textContent='Turno '+(spec.turn||0);
    }
    const cells=String(spec.board||'');
    const n=Math.round(Math.sqrt(cells.length))||7;
    const boardEl=$('spec-board');
    boardEl.innerHTML='';
    boardEl.style.gridTemplateColumns=`repeat(${n},1fr)`;
    boardEl.style.gridTemplateRows=`repeat(${n},1fr)`;
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
  updateWallsToggle();
  const goBtn = $('btn-online-start'); if(goBtn) goBtn.style.display='none';
  $('wait-text').textContent='Esperando rival…';
  $('code-out').textContent='····';
  Net.onReady = onBothReady;
  // Si el invitado se va del lobby antes de empezar, volver a esperar (#22)
  Net.onGuestLeft = ()=>{
    App.oppName=null; App.oppUser=null;
    $('wait-text').textContent='El rival se fue — esperando otro…';
    const go=$('btn-online-start'); if(go) go.style.display='none';
  };
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

// ---- 👤 Usuario: overlay de cuenta (registro / login / sesión) ----
User.load();
const USER_ERR = {
  'formato':     'Usuario: de 3 a 15 caracteres, minúsculas, números o _',
  'pass-corta':  'La contraseña debe tener al menos 6 caracteres.',
  'ocupado':     'Ese usuario ya está tomado.',
  'credenciales':'Usuario o contraseña incorrectos.',
  'ya-logueado': 'Ya hay una sesión iniciada. Cerrala primero.',
  'sin-pass':    'Antes de cerrar sesión creá una contraseña, si no tu usuario queda inaccesible.',
  'sin-usuario': 'No hay usuario en este dispositivo.',
  'sin-conexion':'Sin conexión — probá de nuevo.',
};
// Trae las stats propias (users/{uid}/stats, lectura solo-dueño) para el
// bloque "Mi perfil" del overlay de cuenta.
async function loadProfileStats(){
  const cu = User.current();
  if(!cu || !fbDb) return;
  let s = {};
  try{ s = (await fbDb.ref('users/'+cu.uid+'/stats').get()).val() || {}; }catch(e){}
  $('us-gamesWon').textContent = s.gamesWon || 0;
  $('us-kills').textContent = s.kills || 0;
  $('us-tournamentsWon').textContent = s.tournamentsWon || 0;
}

const UserUI = {
  mode: 'register',   // 'register' | 'login' | 'session'
  open(mode){
    this.mode = mode || (User.name ? 'session' : 'register');
    $('user-err').textContent='';
    $('user-pass').value='';
    if(this.mode!=='session') $('user-input').value='';
    this.render();
    $('user-overlay').hidden=false;
    if(this.mode!=='session') setTimeout(()=>$('user-input').focus(),150);
  },
  render(){
    const m=this.mode, primary=$('user-primary');
    $('user-input').style.display = (m==='session') ? 'none' : 'block';
    $('user-logout').hidden = (m!=='session');
    $('user-stats').style.display = (m==='session') ? 'block' : 'none';
    primary.disabled=false;
    if(m==='register'){
      $('user-title').innerHTML='Creá tu <b>usuario</b>';
      $('user-hint').textContent='Único y permanente, siempre en minúscula. Con la contraseña vas a poder entrar desde cualquier dispositivo. El nickname de cada partida se elige aparte, como siempre.';
      $('user-pass').style.display='block';
      primary.style.display='block'; primary.textContent='Crear cuenta';
      $('user-switch').textContent='¿Ya tenés usuario? Iniciá sesión';
    } else if(m==='login'){
      $('user-title').innerHTML='Iniciar <b>sesión</b>';
      $('user-hint').textContent='Entrá con tu usuario y contraseña.';
      $('user-pass').style.display='block';
      primary.style.display='block'; primary.textContent='Entrar';
      $('user-switch').textContent='¿No tenés usuario? Creá uno';
    } else {   // session
      $('user-title').innerHTML='👤 <b>'+escHtml(User.name||'')+'</b>';
      if(User.hasPassword()){
        $('user-hint').textContent='Sesión iniciada. Podés entrar con este usuario desde cualquier dispositivo.';
        $('user-pass').style.display='none';
        primary.style.display='none';
      } else {
        $('user-hint').textContent='Tu usuario todavía no tiene contraseña. Creá una para poder entrar desde otro dispositivo (y para no perderlo).';
        $('user-pass').style.display='block';
        primary.style.display='block'; primary.textContent='Crear contraseña';
      }
      $('user-switch').textContent='Entrar con otro usuario';
      loadProfileStats();
    }
  },
};
$('btn-user').addEventListener('click', ()=>UserUI.open());
$('user-cancel').addEventListener('click', ()=>{ $('user-overlay').hidden=true; });
$('user-switch').addEventListener('click', ()=>{
  UserUI.open(UserUI.mode==='login' ? 'register' : 'login');
});
$('user-input').addEventListener('input', e=>{
  // Estilizado en vivo: todo minúscula, solo [a-z0-9_]
  const v=e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'');
  if(v!==e.target.value) e.target.value=v;
});
$('user-primary').addEventListener('click', async ()=>{
  const btn=$('user-primary'), err=$('user-err'), m=UserUI.mode;
  const pass=$('user-pass').value;
  err.textContent=''; btn.disabled=true; btn.textContent='…';
  let res;
  if(m==='register')   res = await User.register($('user-input').value, pass);
  else if(m==='login') res = await User.login($('user-input').value, pass);
  else                 res = await User.addPassword(pass);
  if(res.ok){
    $('user-overlay').hidden=true;
    toast(m==='register' ? `Usuario "${User.name}" creado ✓` :
          m==='login'    ? `Sesión iniciada: ${User.name} ✓` :
                           'Contraseña creada ✓');
  } else {
    err.textContent = USER_ERR[res.reason] || USER_ERR['sin-conexion'];
  }
  UserUI.render();   // restaura el botón (label/estado)
});
$('user-logout').addEventListener('click', async ()=>{
  const res = await User.logout();
  if(res.ok){ $('user-overlay').hidden=true; toast('Sesión cerrada'); }
  else $('user-err').textContent = USER_ERR[res.reason] || USER_ERR['sin-conexion'];
});
function setModeUI(id){
  ['mode-single','mode-bo5','mode-t4'].forEach(m=>$(m).classList.toggle('is-on', m===id));
}
$('mode-single').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='single'; setModeUI('mode-single'); updateWallsToggle();
});
$('mode-bo5').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='bo5'; setModeUI('mode-bo5'); updateWallsToggle();
});
$('mode-t4').addEventListener('click', async ()=>{
  if(OT.active) return;
  const ok=await OT.enableTourney();
  if(ok){
    setModeUI('mode-t4');
    // El Modo Paredes no está disponible en torneo online: apagarlo y ocultar el toggle.
    if(App.wallsMode) exitSpecialMode();
    updateWallsToggle();
  }
});
// Toggle 🧱 Modo Paredes del lobby (solo host, no disponible en torneo online).
function updateWallsToggle(){
  const t=$('walls-toggle'); if(!t) return;
  t.style.display = OT.active ? 'none' : 'flex';
  t.classList.toggle('is-on', App.wallsMode);
  $('walls-state').textContent = App.wallsMode ? 'on' : 'off';
}
$('walls-toggle').addEventListener('click', ()=>{
  if(OT.active){ toast('El Modo Paredes no está disponible en el torneo online.'); return; }
  if(App.wallsMode) exitSpecialMode(); else enterWallsMode();
  updateWallsToggle();
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

User.updateUI();   // pinta home-foot (estado online/práctica + usuario si hay)
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

// ===== ⚙️ Config remota (v0.2.83) =====
// El panel de admin (/admin/) escribe overrides de balance en config/ (RTDB).
// Se leen al cargar (sin auth: el nodo es de lectura pública) y pisan CFG.
// Solo claves que ya existen en CFG y con valor numérico; lo demás se ignora.
// Partidas ya empezadas no se tocan; aplica desde la próxima carga de página.
function applyRemoteConfig(){
  if(!fbDb) return;
  fbDb.ref('config').get().then(s=>{
    const c = s.val(); if(!c) return;
    let n=0;
    for(const k in c){
      if(typeof CFG[k]==='number' && typeof c[k]==='number' && CFG[k]!==c[k]){ CFG[k]=c[k]; n++; }
    }
    if(n) console.log('[Rally] Config remota aplicada:', n, 'valores');
  }).catch(()=>{});
}
applyRemoteConfig();

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
})();

// Modo Paredes (menú offline): entra al modo y arranca una partida rápida vs CPU.
// Online se activa con el toggle 🧱 del lobby; el host genera el tablero con
// paredes y lo sincroniza (prefijo "W" en el board).
$('btn-walls').addEventListener('click', ()=>{
  readName(); Tourney.active=false; applyOppCosmetic();
  App.online=false; App.oppName='Cachito';
  enterWallsMode();
  beginGame();
});

// 🧪 Testing: fuerza que TU frenada caiga siempre en la banda de PERFECTO.
let labForcePerfect = false;
$('lab-force-perfect').addEventListener('change', (e)=>{ labForcePerfect = e.target.checked; });

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
