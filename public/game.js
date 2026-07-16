const VERSION = 'v0.3.44';
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
      btn.title = this.name ? fillText('userTooltipNamed', {name:this.name}) : TEXTS.userTooltipCreate;
      btn.classList.toggle('has-user', !!this.name);
    }
    const foot = $('home-foot');
    if(foot){
      const base = DEMO ? TEXTS.homeFootDemo : TEXTS.homeFootOnline;
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

// ===== 🎖️ Niveles / EXP del jugador (v0.3.36) =====
// EXP se gana en TODAS las batallas (online y offline), la gane quien la gane —
// se guarda SIEMPRE en localStorage (aplica al instante, incluso anónimo) y, si
// hay sesión, se espeja en users/{uid}/exp para que el nivel siga a la cuenta
// entre dispositivos (mismo patrón que Profile/TourneyProgress). El nivel se
// DERIVA del total acumulado (no se guarda aparte): cada nivel pide un poco más
// que el anterior. La escritura remota usa transaction con Math.max para nunca
// bajar el valor de la cuenta si otro dispositivo ya sumó más ("lo mejor gana",
// igual criterio que TourneyProgress.loadRemote).
const EXP_KEY = 'rally_exp';
function expNeededForLevel(lvl){ return CFG.expPerLevelBase + (lvl-1)*CFG.expPerLevelStep; }
// Desglosa un total acumulado en {level, into, need, frac}: into = EXP dentro del
// nivel actual, need = EXP para el próximo, frac = 0..1 para la barra.
function expBreakdown(total){
  let lvl=1, rem=Math.max(0, total|0);
  while(rem >= expNeededForLevel(lvl)){ rem -= expNeededForLevel(lvl); lvl++; }
  const need = expNeededForLevel(lvl);
  return { level:lvl, into:rem, need, frac: need>0 ? rem/need : 0 };
}
const Exp = {
  total: 0,
  load(){
    try{ this.total = Math.max(0, parseInt(localStorage.getItem(EXP_KEY),10) || 0); }
    catch(e){ this.total = 0; }
    updateProfileLevel();
  },
  save(){
    try{ localStorage.setItem(EXP_KEY, String(this.total)); }catch(e){}
    const cu = User.current();
    if(cu && fbDb) fbDb.ref('users/'+cu.uid+'/exp').transaction(cur=>Math.max(cur||0, this.total)).catch(()=>{});
  },
  // Suma EXP; devuelve el desglose antes/después (para animar el resultado) o
  // null si amount<=0. Actualiza local + cuenta + la UI del perfil.
  add(amount){
    amount = amount|0;
    if(amount<=0) return null;
    const before = expBreakdown(this.total);
    this.total += amount;
    this.save();
    const after = expBreakdown(this.total);
    updateProfileLevel();
    return { gained:amount, before, after, leveledUp: after.level>before.level };
  },
  // Al abrir el perfil / al iniciar sesión: se queda con lo mejor entre local y
  // la cuenta y re-escribe (mismo criterio que TourneyProgress.loadRemote).
  async loadRemote(){
    const cu = User.current();
    if(!cu || !fbDb) return;
    try{
      const remote = Math.max(0, parseInt((await fbDb.ref('users/'+cu.uid+'/exp').get()).val(),10) || 0);
      if(remote > this.total){ this.total = remote; try{ localStorage.setItem(EXP_KEY, String(this.total)); }catch(e){} }
      else if(this.total > remote){ this.save(); }   // subir lo local si la cuenta va atrás
      updateProfileLevel();
    }catch(e){}
  },
  info(){ return expBreakdown(this.total); },
};
// Otorga EXP por el fin de una batalla. outcome: 'win'|'lose'|'tie' (el empate
// da lo mismo que una derrota); tier: 'online'|'offline'|'practice'. Devuelve el
// resultado de Exp.add (o null si el monto configurado fuese 0).
function grantBattleExp(outcome, tier){
  const win = outcome==='win';
  let amount;
  if(tier==='online')       amount = win ? CFG.expWinOnline   : CFG.expLoseOnline;
  else if(tier==='offline') amount = win ? CFG.expWinOffline  : CFG.expLoseOffline;
  else                      amount = win ? CFG.expWinPractice : CFG.expLosePractice;
  return Exp.add(amount);
}

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
    // Sincronizar EXP con la cuenta apenas se asienta la sesión (lo mejor gana),
    // así el nivel ya está al día para el próximo resultado. Corre para cualquier
    // usuario (anónimo o real): el uid persiste al registrarse (link), y al
    // loguearse en otro dispositivo trae el de la cuenta.
    // ⚠️ NUNCA durante una partida en curso: en el celu la auth se asienta a los
    // pocos segundos (justo cuando puede estar corriendo el primer duelo) y un
    // .get()/transacción de Firebase resolviendo DENTRO de la ventana del duelo
    // mete trabajo en el main thread y puede trabar la aguja (disciplina de
    // "ventana del duelo limpia", lección recurrente). No se pierde nada: el
    // perfil hace loadRemote al abrirse y la transacción Math.max de endGame ya
    // sincroniza el total con la cuenta al terminar cada partida.
    if(u && typeof Exp!=='undefined' && !(typeof G!=='undefined' && G.running)) Exp.loadRemote();
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
  oppSkin: null,    // id de skin elegida por el rival (solo online), para verla en su ficha
  roomCode: null,
  online: false,
  muted: false,
  isHost: false,
  matchMode: 'bo5',      // 'single' | 'bo5' ('bo5' = serie; hoy es "mejor de 3", default online)
  scoreYou: 0,           // rondas ganadas (serie)
  scoreOpp: 0,
  roundHist: [],         // historial de rondas de la serie: 'you' | 'opp' (para los puntos)
  wallsMode: false,      // Modo Paredes (experimental)
  chaosMode: false,      // Modo Caos (experimental): cofres, portales y más
};

// Entra/sale de modos con tablero especial (ajusta el tamaño global).
// Paredes y Caos son mutuamente excluyentes: cada enter apaga al otro.
function enterWallsMode(){ App.wallsMode = true;  App.chaosMode = false; CFG.boardSize = CFG.wallsBoardSize; }
function enterChaosMode(){ App.chaosMode = true;  App.wallsMode = false; CFG.boardSize = CFG.boardSizeDefault; Walls.clear(); }
function exitSpecialMode(){ App.wallsMode = false; App.chaosMode = false; CFG.boardSize = CFG.boardSizeDefault; Walls.clear(); }
// La serie online es "mejor de 3": gana quien llega a 2 rondas. (El valor
// interno del modo sigue siendo 'bo5' para no tocar el wire/las reglas.)
const BO5_TARGET = 2;
const SERIES_ROUNDS = 3;      // puntos que se muestran en el marcador de rondas
// El Torneo offline queda afuera del recorte de vida (CFG.maxHp 100→35):
// el jugador arranca cada corrida con la vida clásica.
const TOURNEY_YOU_HP = 100;

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

// Progreso de Torneo offline: guarda, por rival (índice), el mejor HP con el
// que se llegó a esa ronda — cache local + espejo en la cuenta si hay sesión
// (mismo patrón que Profile/skin). Permite "Retomar torneo" sin rejugar desde 0.
const TOURNEY_PROGRESS_KEY = 'rally_tourney_progress';
const TourneyProgress = {
  best: {}, // {index: hp con el que se entró a esa ronda}
  load(){
    try{ const raw = localStorage.getItem(TOURNEY_PROGRESS_KEY); this.best = raw ? JSON.parse(raw) : {}; }
    catch(e){ this.best = {}; }
    updateTourneyResumeUI();
  },
  save(){
    try{ localStorage.setItem(TOURNEY_PROGRESS_KEY, JSON.stringify(this.best)); }catch(e){}
    const cu = User.current();
    if(cu && fbDb) fbDb.ref('users/'+cu.uid+'/tourneyProgress').set(this.best).catch(()=>{});
  },
  // Registra el HP con el que se ENTRA a la ronda `idx`; solo guarda si mejora la marca.
  record(idx, hp){
    const cur = this.best[idx];
    if(cur == null || hp > cur){ this.best[idx] = hp; this.save(); updateTourneyResumeUI(); }
  },
  // Trae el progreso de la cuenta (si hay sesión) y se queda con lo mejor entre
  // lo local y lo remoto para cada rival — mismo criterio que Profile.loadRemote().
  async loadRemote(){
    const cu = User.current();
    if(!cu || !fbDb) return;
    try{
      const v = (await fbDb.ref('users/'+cu.uid+'/tourneyProgress').get()).val() || {};
      Object.keys(v).forEach(k=>{ if(this.best[k]==null || v[k]>this.best[k]) this.best[k]=v[k]; });
      try{ localStorage.setItem(TOURNEY_PROGRESS_KEY, JSON.stringify(this.best)); }catch(e){}
    }catch(e){}
    updateTourneyResumeUI();
  },
  reached(){ return Object.keys(this.best).map(Number).sort((a,b)=>a-b); },
};
function tourneyHpFor(i){
  // Override del editor de personajes (characters/roster) si existe
  const r = TOURNEY_ROSTER[i];
  if(r && typeof r.hp === 'number' && r.hp > 0) return r.hp;
  // Exponencial 10 → 200 a lo largo de la ronda (n = roster length)
  const n = TOURNEY_ROSTER.length;
  const t = n>1 ? i/(n-1) : 1;
  return Math.round(10 * Math.pow(200/10, t)); // 10,~15,...,200
}
function tourneySkillFor(i){
  // Override del editor de personajes (characters/roster) si existe
  const r = TOURNEY_ROSTER[i];
  if(r && typeof r.skill === 'number' && r.skill >= 0 && r.skill <= 1) return r.skill;
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
  { id:'intro-match', type:'match', opp:{ name:'Tarata', hp:11, skill:0.35, sprite:'sprites/tarata.webp', spriteMove:'sprites/tarata_move.webp' } },
  // ⚠️ Ojo: si existe campaign/script en Firebase (editor /admin/), applyRemoteCampaign()
  // REEMPLAZA esta cinta entera y los nodos remotos no traen `sprite`/`spriteMove`. Por eso
  // además existe NPC_SPRITES (fallback por nombre de rival) más abajo.
  // ← próximos nodos de la campaña van acá (escenas, partidas con mecánicas
  //    nuevas, giros de historia). Ejemplo:
  // { id:'s1', type:'scene', lines:['Cachito te mira fijo.', 'Algo cambió.'] },
];

// Sprites de imagen por nombre de rival de campaña. Fallback para cuando el
// nodo no trae `sprite`/`spriteMove` propios (típico: la cinta vino del editor
// /admin/ vía campaign/script, que no conoce esos campos). Los del nodo siempre
// ganan. `move` es opcional: si falta, el marker se queda con el sprite idle
// todo el desplazamiento (ver flipMarker).
const NPC_SPRITES = {
  'Tarata': { idle:'sprites/tarata.webp', move:'sprites/tarata_move.webp' },
};

const Campaign = {
  active:false,   // true mientras el jugador está DENTRO de la campaña
  node:0,         // índice del nodo actual en CAMPAIGN_SCRIPT
  data:null,      // save: { v, node, name, flags, history, startedAt, updatedAt }
  replaying:false, // true mientras se rejuega un nivel YA superado (selector de niveles)

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
  // Frente real de la campaña (nodo guardado) — no se mueve mientras se rejuega
  // un nivel viejo desde el selector de niveles.
  maxNode(){
    if(this.data===null) this.load();
    return this.data ? (this.data.node||0) : 0;
  },
  // Entra a un nivel puntual desde el selector (hexágonos). Si es un nivel ya
  // superado, queda marcado como "replaying" para no pisar el progreso real.
  enterLevel(idx){
    this.replaying = idx < this.maxNode();
    this.enter(idx);
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
    if(this.data && !this.replaying){
      this.data.history.push(done ? (done.id || this.node-1) : this.node-1);
      this.data.node = this.node;
      this.save();
    }
  },
  advance(){
    this.completeCurrent();
    if(this.replaying){
      // Nivel viejo ya terminado: salta directo al frente real de la campaña,
      // sin repetir los niveles intermedios que ya había superado.
      this.replaying=false;
      this.node=this.maxNode();
    }
    this.enter(this.node);
  },
  // Igual que advance() pero pensado para el botón "Continuar ▸" del resultado
  // de un match (que no pasa por completeCurrent()+enter() encadenados).
  continueAfterWin(){
    if(this.replaying){ this.replaying=false; this.node=this.maxNode(); }
    this.enter(this.node);
  },
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
    playScene([TEXTS.campaignToBeContinued], ()=>show('home'));
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
  const hpEdge   = (G.opp.hp - G.you.hp) / (G.you.maxHp || CFG.maxHp);
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
  if(screen==='home' && (App.wallsMode || App.chaosMode) && !G.running){ exitSpecialMode(); }
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('is-active'));
  $('screen-'+screen).classList.add('is-active');
  App.screen = screen;
  if(screen==='home') GolBg.start(); else GolBg.stop();
  // El botón de tema se ve en cualquier pestaña SALVO en la partida (ahí pisa
  // el HUD de vida; el pie de partida tiene su propio toggle ☾/☀). Info y
  // usuario solo en el inicio.
  const tb = $('btn-theme');
  if(tb) tb.classList.toggle('is-hidden', screen === 'game');
  const lb = $('btn-lang');
  if(lb) lb.classList.toggle('is-hidden', screen === 'game');
  const ib = $('btn-info');
  if(ib) ib.classList.toggle('is-hidden', screen !== 'home');
  const ub = $('btn-user');
  if(ub) ub.classList.toggle('is-hidden', screen !== 'home');
}
function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
let toastT;
function toast(msg, ms=2600){
  const t = $('toast');
  // escapa el texto y luego reemplaza el marcador {ring} por el mini-anillo
  const esc = escHtml(msg);
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
    // stopChat PRIMERO (evita listeners duplicados de una ronda anterior) y
    // recién después el callback: stopChat también hace onChatMessage=null,
    // así que al revés borraba el callback recién asignado y el chat quedaba
    // mudo (no se mostraba ningún mensaje, ni propio ni del rival).
    Net.stopChat();
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
  // Secuencia de blips ([freq,dur,vol,type,delayMs]). El guard de mute vive en
  // blip y se evalúa nota por nota: mutear a mitad de un sting corta el resto.
  seq(steps){ steps.forEach(s=> setTimeout(()=> this.blip(s[0],s[1],s[2],s[3]), s[4]||0)); },
  perfect(){ this.seq([[880,0.06,0.05,'triangle',0],[1320,0.09,0.05,'triangle',70]]); },
  fanfare(){ this.seq([[523,0.09,0.05,'triangle',0],[659,0.09,0.05,'triangle',100],[784,0.14,0.05,'triangle',200]]); },
  champion(){ this.seq([[523,0.09,0.05,'triangle',0],[659,0.09,0.05,'triangle',110],[784,0.09,0.05,'triangle',220],[1046,0.22,0.06,'triangle',330]]); },
  loseSting(){ this.seq([[330,0.12,0.04,'sawtooth',0],[247,0.16,0.04,'sawtooth',130]]); },
};
function haptic(ms){ if(navigator.vibrate && !App.muted){ try{ navigator.vibrate(ms); }catch(e){} } }

function prefersReduced(){ return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }
// Re-dispara una animación CSS one-shot: saca la clase, fuerza reflow, la
// vuelve a poner (si solo se agrega, un segundo disparo con la clase ya
// puesta no re-anima porque la animación CSS no se reinicia sola).
function popClass(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
// Tween numérico del textContent (ease-out cúbico, aprox del cubic-bezier de
// las barras de HP). Cancela un tween previo del mismo elemento.
function tweenNum(el, from, to, ms=900){
  if(el._twnRaf) cancelAnimationFrame(el._twnRaf);
  if(prefersReduced()){ el.textContent=to; return; }
  const t0=performance.now();
  const ease=(t)=>1-Math.pow(1-t, 3);
  const tick=(now)=>{
    const t=Math.min(1,(now-t0)/ms);
    el.textContent=Math.round(from+(to-from)*ease(t));
    el._twnRaf = t<1 ? requestAnimationFrame(tick) : null;
  };
  el._twnRaf=requestAnimationFrame(tick);
}
// Sacudida corta del tablero (one-shot, transform-only). La clase vive en
// #board, que renderBoard() NO regenera (regenera sus hijos) → limpieza propia.
function shakeBoard(){
  if(prefersReduced()) return;
  const b=$('board'); if(!b) return;
  popClass(b,'is-shake');
  b.addEventListener('animationend', ()=>b.classList.remove('is-shake'), {once:true});
}

// ===== 🧬 Fondo Game of Life del menú (v0.3.43, ajustes v0.3.44) =====
// Puramente estético, detrás del contenido de #screen-home. Corre SOLO con el
// home activo (show() lo prende/apaga); rAF se congela en pestaña oculta =
// pausa gratis. Tablero toroidal (bordes envueltos) para que los gliders
// recirculen en vez de morir en los márgenes. La opacidad vive en el CSS
// (.gol-bg) — acá se dibuja a alpha pleno.
// ⚠️ Debe declararse ANTES de autoJoinFromURL: ese IIFE llama show('home')
//    sincrónico a nivel top y un const tardío sería TDZ ReferenceError.
const GolBg = {
  on:false, raf:0, last:0,
  stepMs:140,             // ~7.2 generaciones/seg (v0.3.44: el doble de rápido)
  cell:9, gap:1.5,        // px CSS por celda / separación (célula dibujada 7.5px, v0.3.44: más chica)
  density:0.14,           // fracción viva del sembrado
  cols:0, rows:0, grid:null, next:null,
  cv:null, ctx:null,
  stag:0, pop1:-2, pop2:-1,   // poblaciones de hace 1 y 2 generaciones

  init(){
    this.cv = $('gol-bg'); if(!this.cv) return;
    this.ctx = this.cv.getContext('2d');
    this.resize();
    // v0.3.44: el canvas es fixed a todo el viewport (vive fuera de #app,
    // que tiene max-width:520px) — mide contra <body>, no contra screen-home.
    if(typeof ResizeObserver !== 'undefined'){
      let t=0;
      new ResizeObserver(()=>{ clearTimeout(t); t=setTimeout(()=>this.resize(),250); })
        .observe(document.body);
    }
  },

  resize(){
    const w=this.cv.clientWidth, h=this.cv.clientHeight;
    if(!w || !h) return;
    const cols=Math.ceil(w/this.cell), rows=Math.ceil(h/this.cell);
    // El jiggle de dvh de iOS (barra de URL) dispara resizes sin cambiar la
    // grilla — no resembrar por eso.
    if(cols===this.cols && rows===this.rows) return;
    // Fondo difuso-ok a esta opacidad: tope 1.5 de dpr (mitad de fill-cost).
    const dpr=Math.min(window.devicePixelRatio||1, 1.5);
    this.cv.width=Math.round(w*dpr); this.cv.height=Math.round(h*dpr);
    this.ctx.setTransform(dpr,0,0,dpr,0,0);   // dibujar en px CSS
    this.cols=cols; this.rows=rows;
    this.grid=new Uint8Array(cols*rows); this.next=new Uint8Array(cols*rows);
    this.seed();
    this.draw(true);
  },

  seed(){
    for(let i=0;i<this.grid.length;i++) this.grid[i] = Math.random()<this.density ? 1 : 0;
    this.stag=0; this.pop1=-2; this.pop2=-1;
  },

  step(){
    const cols=this.cols, rows=this.rows, grid=this.grid, next=this.next;
    let pop=0;
    for(let y=0;y<rows;y++){
      const yu=((y-1+rows)%rows)*cols, yc=y*cols, yd=((y+1)%rows)*cols;
      for(let x=0;x<cols;x++){
        const xl=(x-1+cols)%cols, xr=(x+1)%cols;
        const n = grid[yu+xl]+grid[yu+x]+grid[yu+xr]
                + grid[yc+xl]           +grid[yc+xr]
                + grid[yd+xl]+grid[yd+x]+grid[yd+xr];
        const v = (n===3 || (grid[yc+x] && n===2)) ? 1 : 0;
        next[yc+x]=v; pop+=v;
      }
    }
    this.grid=next; this.next=grid;
    // Anti-estancamiento: población igual a la de hace 2 gens cubre naturalezas
    // muertas (p1) y osciladores p2 (el final típico); también colapso (<2%).
    if(pop===this.pop2 || pop < this.grid.length*0.02) this.stag++; else this.stag=0;
    this.pop2=this.pop1; this.pop1=pop;
    if(this.stag>180 || pop===0) this.seed();   // ~25s quieto → resembrar (stepMs se acortó, umbral se ajustó)
  },

  draw(hard){
    const c=this.ctx, w=this.cv.clientWidth, h=this.cv.clientHeight;
    if(hard){ c.clearRect(0,0,w,h); }
    else{
      // Estela suave: desvanecer el frame previo en vez de borrado duro — las
      // células muertas se apagan en ~4-5 gens y el 4Hz se ve calmo.
      c.globalCompositeOperation='destination-out';
      c.fillStyle='rgba(0,0,0,0.45)';
      c.fillRect(0,0,w,h);
      c.globalCompositeOperation='source-over';
    }
    // Color releído por generación (~4/s, barato): sigue el tema sin
    // acoplarse a applyTheme().
    c.fillStyle=(getComputedStyle(document.documentElement).getPropertyValue('--ink')||'#888').trim();
    const s=this.cell-this.gap;
    for(let y=0;y<this.rows;y++){
      const off=y*this.cols, py=y*this.cell;
      for(let x=0;x<this.cols;x++)
        if(this.grid[off+x]) c.fillRect(x*this.cell, py, s, s);
    }
  },

  tick(ts){
    if(!this.on) return;
    if(ts-this.last>=this.stepMs){ this.last=ts; this.step(); this.draw(false); }
    this.raf=requestAnimationFrame(this._tick);
  },

  start(){
    if(!this.cv) return;
    this.cv.classList.add('is-shown');
    if(this.on) return;
    // Movimiento reducido: un frame sembrado estático (2 gens de "cocción"
    // para que no parezca ruido puro) y nada de animación.
    if(prefersReduced()){ this.step(); this.step(); this.draw(true); return; }
    this.on=true; this.last=0;
    this._tick=this._tick||(ts=>this.tick(ts));
    this.raf=requestAnimationFrame(this._tick);
  },

  stop(){
    this.on=false;
    if(this.raf){ cancelAnimationFrame(this.raf); this.raf=0; }
    if(this.cv) this.cv.classList.remove('is-shown');
  },
};
GolBg.init();
if(App.screen==='home') GolBg.start();   // el home viene pre-activo en el HTML

const CFG = {
  boardSize: 7,
  boardSizeDefault: 7,   // tamaño normal (para restaurar al salir de modos especiales)
  wallsBoardSize: 9,     // tamaño del mapa en Modo Paredes
  wallsCount: 14,        // cantidad de segmentos de pared a generar
  maxHp: 35,           // antes 100: partidas más rápidas (el Torneo offline mantiene 100 vía TOURNEY_YOU_HP)
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
  ringBigHeal: 18,           // cura grande si cumple condiciones (era 50 con maxHp 100)
  ringHealDiff: 7,           // diferencia de HP requerida (era 20 con maxHp 100)
  ringHealUnder: 14,         // HP máximo del que lo agarra para la cura grande (era 40)
  ringDripHeal: 2,           // cura por ronda si no cumple (era 5 con maxHp 100)
  ringDripRounds: 5,         // cantidad de rondas de cura chica
  chestCount: 2,        // 🌀 Modo Caos: cofres sorpresa en el tablero
  chestHeal: 8,         // curación si el cofre sale "curación"
  bombCount: 2,         // 🌀 Modo Caos: bombas en el tablero
  bombFuse: 2,          // resoluciones de turno entre armado y explosión
  bombDamage: 12,       // daño de la explosión (con piedad: nunca mata)
  bombArea: 0,          // 0 = cruz (5 casillas) · 1 = 3x3 (9 casillas)
  highCount: 3,         // 🌀 Modo Caos: casillas de terreno alto
  highBonus: 2,         // daño extra por duelar parado en terreno alto
  bootsCount: 1,        // 🌀 Modo Caos: botas de doble paso en el tablero
  bootsRange: 2,        // alcance del movimiento con botas (radio, 1 pick)
  duelCountdownMs: 800,
  duelCycleDuration: 1.8,
  cpuDesperateTrapRatio: 0.6,
  cpuDesperateHpMin: 30,   // % del maxHp del rival (calibrado como 30/100; ver cpuDesperateHp)
  // 🎖️ Niveles / EXP (v0.3.36). El online rinde ~2× que el offline; la práctica
  // vs CPU (y rejugar niveles de campaña ya superados) rinde lo mínimo, para no
  // farmear contra rivales fáciles. La curva pide `base + step*(nivel-1)` por nivel.
  expWinOnline: 70,
  expLoseOnline: 30,
  expWinOffline: 50,
  expLoseOffline: 22,
  expWinPractice: 25,
  expLosePractice: 12,
  expPerLevelBase: 60,    // EXP para pasar de nivel 1 a 2
  expPerLevelStep: 20,    // cuánto más pide cada nivel siguiente
};

// Umbral de "desesperación" de la CPU. cpuDesperateHpMin se calibró cuando
// maxHp era 100 (30 = 30% de vida); al recortarse maxHp a 35 el valor absoluto
// quedó cubriendo casi toda la partida (30 de 35 = 86%). Se interpreta como
// PORCENTAJE del maxHp real del rival: sirve igual para práctica (35), torneo
// offline (10→200) y campaña (hp por nodo).
function cpuDesperateHp(){
  return (G.opp.maxHp || CFG.maxHp) * CFG.cpuDesperateHpMin / 100;
}

// ===== 📝 Textos del juego (editables desde /admin/, v0.2.97) =====
// Todo el texto que ve un jugador (mensajes, toasts, pantallas de resultado,
// nombres de personajes) vive acá — nunca hardcodeado en el resto del
// archivo. Mismo patrón que CFG/config/: defaults acá, overrides opcionales
// en Firebase (nodo `texts/`, sparse), aplicados una vez al cargar por
// applyRemoteTexts(). Los `{placeholder}` se rellenan en runtime con fillText().
const TEXTS_ES = {
  // --- Desconexión / abandono / inactividad ---
  abandonFlavorPool: 'Al parecer sos intimidante\nTe tuvieron miedo\nLo llamaron a comer',
  toastOpponentWaiting: 'Rival desconectado… esperando reconexión',
  msgOpponentWaiting: '⚠️ Rival desconectado — esperando…',
  toastOpponentBack: 'Rival reconectado ✓',
  toastTourneyOppLeft: 'Tu rival abandonó — pasás de ronda',
  resultAbandonNote: '(por abandono…)',
  resultVictoryTitle: 'VICTORIA',
  toastSeriesOppLeft: 'El rival abandonó la serie.',
  toastRoomOppLeft: 'El rival abandonó la sala.',
  toastRoomClosed: 'La sala se cerró.',
  toastIdleAutoMove: 'Te moviste solo por inactividad ({streak}/{max})',
  toastIdleForfeit: 'Te desconectamos por inactividad — perdiste la partida.',
  toastOppAutoMove: '⏱️ El rival tardó demasiado: se movió solo ({streak}/{max})',
  toastOppGoneAuto: '📡 Rival desconectado — la partida sigue sola',
  toastMoveError: 'Error al enviar movimiento.',

  // --- Cómo se juega (overlay corto antes de la partida) ---
  howtoTitle: 'Cómo se juega',
  howtoText: 'Movete por el tablero. Agarrá espadas y escudos, y evitá las cruces. Al encontrarte con el rival, duelo.',
  howtoLegendAtk: '+daño próximo duelo',
  howtoLegendDef: '+defensa próximo duelo',
  howtoLegendDown: 'daño directo',
  howtoHint: 'En el duelo: frená la aguja en la zona verde.',

  // --- Cómo se juega (pantalla larga de referencia) ---
  infoIntro: 'Movete una casilla por turno (incluidas diagonales). Los dos eligen y se mueven a la vez. Objetivo: llegar al duelo con ventaja y vaciar la vida del rival.',
  infoItemDmg: '<b>Poder de daño.</b> Suma daño a tus golpes. Se acumula.',
  infoItemDef: '<b>Poder de defensa.</b> Reduce el daño que recibís. También se acumula.',
  infoItemTrap: '<b>Trampa.</b> Te resta vida al pisarla, pero nunca te mata. Mejor esquivarla.',
  infoItemRing: '<b>Anillo.</b> Raro. Cura mucho de golpe si estás muy herido, o de a poco por varias rondas si no.',
  infoDuelIntro: 'Al encontrarte con el rival arranca un duelo de reflejos: frená la aguja en la mejor zona posible.',
  infoZoneGreen: '<b>Verde</b> — buen golpe.',
  infoZoneYellow: '<b>Amarillo</b> — golpe medio.',
  infoZoneOrange: '<b>Naranja</b> — golpe flojo.',
  infoZoneRed: '<b>Rojo</b> — casi sin daño.',
  infoPerfect: 'En el centro del verde hay una franja fina: el <b>PERFECTO</b>. Vale doble y duplica tu poder de daño, pero solo en la <b>primera pasada</b>.',
  infoPerfectCancels: 'Un PERFECTO <b>anula los poderes del rival</b> si él no hizo perfecto también.',
  infoScoreDecay: 'Cuantas más pasadas tardes en frenar, menos vale el rojo. Gana quien saque más puntaje; el que pierde igual hace algo de daño.',
  infoMercy: 'Ganar un duelo o pisar una trampa nunca te mata: solo <b>perder</b> un duelo puede. Ítem compartido: sorteo parejo.',
  infoWalls: '<b>Modo Paredes</b> (beta): mapa más grande con paredes que bloquean el paso recto, bordeables en diagonal. En el menú offline o con el toggle 🧱 online (no en torneo x4).',

  // --- Toasts generales ---
  toastRingBig: '{ring} {who} +{heal} HP',
  toastRingDrip: '{ring} {who} +{heal} HP x{rounds}',
  toastTourneyFinal: '¡A la final! ⚔️',
  toastNeedConnection: 'El torneo online necesita conexión.',
  toastCreateRoomFirst: 'Primero creá la sala.',
  toastChangeModeBeforeJoin: 'Cambiá el modo antes de que entre tu rival.',
  toastTourneyFull: 'Ya hay jugadores en el torneo.',
  toastTourneyStartFail: 'No se pudo iniciar el torneo.',
  toastCreateRoomFail: 'No se pudo crear la sala. Revisá tu conexión.',
  waitTextWaitingOpp: 'Esperando rival…',
  waitTextOppLeft: 'El rival se fue — esperando otro…',
  waitTextPracticeAvailable: 'Modo práctica disponible',
  userHintRegister: 'Único y permanente, siempre en minúscula. Con la contraseña vas a poder entrar desde cualquier dispositivo. El nickname de cada partida se elige aparte, como siempre.',
  userHintLogin: 'Entrá con tu usuario y contraseña.',
  userHintSession: 'Sesión iniciada. Podés entrar con este usuario desde cualquier dispositivo.',
  userHintNoPassword: 'Tu usuario todavía no tiene contraseña. Creá una para poder entrar desde otro dispositivo (y para no perderlo).',
  toastWallsNotOnlineTourney: 'El Modo Paredes no está disponible en el torneo online.',
  toastChaosNotOnlineTourney: 'El Modo Caos no está disponible en el torneo online.',
  chestGotAtk: '🎁 {name}: 🗡️ +daño',
  chestGotDef: '🎁 {name}: ◈ +defensa',
  chestGotHeal: '🎁 {name}: +{hp} HP',
  chestTrap: '🎁 {name}: ¡era una trampa!',
  chestTeleport: '🎁 {name}: ¡teletransporte!',
  bombArmed: '💣 Bomba activada: ¡alejate!',
  bombExploded: '💥 ¡BUM!',
  bootsPicked: '👟 {name}: doble paso en el próximo turno',
  rpsCaption: '¡Piedra, papel o tijera por el ítem!',
  rpsWaitingOpp: 'Esperando al rival…',
  rpsOppReady: 'El rival ya eligió',
  rpsNoPickYou: '⏰ No elegiste a tiempo',
  rpsWinnerLine: '{name} se lo lleva',
  rpsTieLine: '¡Empate! Lo decide la suerte…',
  infoChaos: '<b>Modo Caos</b> (beta): cofres sorpresa 🎁, portales 🌀, bombas con mecha 💣, terreno alto ⛰️ y botas de doble paso 👟. En el menú offline o con el toggle 🌀 online (no en torneo x4).',
  toastLabAdminsOnly: 'El laboratorio es solo para admins.',
  toastCodeLength: 'El código tiene 4 caracteres.',
  toastPracticeMode: 'Modo práctica: jugás contra la CPU.',
  toastRoomNotFound: 'Esa sala no existe.',
  toastRoomFull: 'La sala ya está llena.',
  toastJoinFail: 'No se pudo unir a la sala.',
  toastConnectionError: 'Error de conexión.',
  toastWaitForCode: 'Esperá a que se genere el código.',
  toastLinkCopiedClipboard: 'Link copiado al portapapeles ✓',
  toastLinkCopied: 'Link copiado ✓',
  toastYourLink: 'Tu link: {url}',
  toastInviteDetected: 'Invitación detectada · elegí tu nombre y entrá',
  toastUserCreated: 'Usuario "{user}" creado ✓',
  toastSessionStarted: 'Sesión iniciada: {user} ✓',
  toastPasswordCreated: 'Contraseña creada ✓',
  toastSessionClosed: 'Sesión cerrada',

  // --- Errores de cuenta (creación/login) ---
  errUserFormat: 'Usuario: de 3 a 15 caracteres, minúsculas, números o _',
  errPassShort: 'La contraseña necesita al menos 6 caracteres.',
  errUserTaken: 'Ese usuario ya existe.',
  errCredentials: 'Usuario o contraseña incorrectos.',
  errAlreadyLoggedIn: 'Ya iniciaste sesión con contraseña.',
  errNoPassword: 'Todavía no tenés contraseña — creala primero.',
  errNoUser: 'Primero creá tu usuario.',
  errNoConnection: 'Error de conexión. Probá de nuevo.',

  // --- Mensajes del pie de turno (setMsg) ---
  msgTruce: 'Tregua 🛡️ — elegí a dónde moverte',
  msgChooseCell: 'Elegí un casillero contiguo para moverte',
  msgOppChoseFirst: 'El rival ya eligió — te toca mover',
  msgWaitingOpp: 'Esperando al rival…',
  msgMoving: 'Moviendo…',
  msgDuelImminent: 'Duelo inminente…',
  msgRepositioning: 'Reposicionando…',

  // --- Globos de inicio de partida ---
  bubbleYou: 'Vos',
  bubbleRival: 'Rival',

  // --- Nombres de personajes ---
  oppNamePractice: 'Cachito',
  campaignOpp1Name: 'Tarata',
  rosterName0: 'Maurice',
  rosterName1: 'Mort',
  rosterName2: 'Clover',
  rosterName3: 'Skipper',
  rosterName4: 'Kowalski',
  rosterName5: 'Marlene',
  rosterName6: 'Alex',
  rosterName7: 'Rey Julian',
  cpuNamesPool: 'Beto\nRulo\nCacho\nPipa\nTato\nCoco\nPocho\nTurco\nChino\nFlaco\nNino\nQuique',

  // --- Duelo: veredicto y resultado ---
  duelPerfectPrefix: '<b style="color:var(--perfect)">PERFECTO</b> · ',
  duelVerdictWin: '{perfectPrefix}<b style="color:var(--good)">GANA</b> {name}',
  duelVerdictLose: '{perfectPrefix}<b style="color:var(--bad)">GANA</b> {name}',
  duelVerdictTie: '<b style="color:var(--warn)">EMPATE</b>',
  duelTitleEncounter: '¡Encuentro!',
  duelTitleStopGreen: 'Frená en verde',
  duelCountdownGo: '¡YA!',
  duelResultTitle: 'Resultado',
  duelTieTitle: 'Empate',
  duelTieSub: 'Nadie pierde vida — ambos salen expulsados',
  duelWinTitle: 'Ganaste el duelo',
  duelLoseTitle: 'Perdiste el duelo',
  duelPerfectSub: '⭐ PERFECTO de {name}',
  duelPassLabel: 'pase {pass}/{max}',
  duelLastPassLabel: 'último pase',
  zoneNamePerfect: 'PERFECTO',
  zoneNameGreen: 'Verde',
  zoneNameYellow: 'Amarillo',
  zoneNameOrange: 'Naranja',
  zoneNameRed: 'Rojo',

  // --- Fin de partida (online 1v1/bo5, campaña, torneo offline) ---
  resultFinalEyebrow: 'Final',
  resultBo5Eyebrow: 'Mejor de 3 · {scoreYou}–{scoreOpp}',
  resultTieTitle: 'Empate',
  resultWinTitle: 'Ganaste',
  resultLoseTitle: 'Perdiste',
  resultWinRoundTitle: 'Ganaste la ronda',
  resultLoseRoundTitle: 'Perdiste la ronda',
  resultWinSeriesTitle: '🏆 Ganaste la serie',
  resultLoseSeriesTitle: 'Perdiste la serie',
  resultScoreRounds: 'Rondas: <b>{scoreYou}</b> – <b>{scoreOpp}</b>',
  resultScoreHp: '<b>{youHp}</b> HP vs <b>{oppHp}</b> HP',
  campaignRetryLabel: 'Reintentar',
  tourneyChampionTitle: '¡Campeón!',
  tourneyChampionScore: 'Venciste a <b>{name}</b> y ganaste el torneo con <b>{hp}</b> HP restante.',
  tourneyRoundEyebrow: 'Rival {i}/{n}',
  tourneyBeatOpp: 'Venciste a {name}',
  tourneyHpLeft: 'Te quedan <b>{hp}</b> HP. Próximo rival con más vida y más astuto.',
  tourneyEliminatedTitle: 'Eliminado',
  tourneyEliminatedScore: 'Llegaste hasta el rival <b>{i}/{n}</b> ({name}).',
  tourneyRetryLabel: 'Reintentar rival',
  tourneyChampionEyebrow: '🏆 Torneo',
  tourneyEyebrow: 'Torneo',

  // --- Niveles / EXP (v0.3.36) ---
  resultExpGain: '+{n} EXP',
  levelLabel: 'Nivel {n}',
  levelUpFlash: '¡Nivel {n}!',
  expProgress: '{into} / {need} EXP',

  // --- Torneo online x4: hub y espectador ---
  otChampionTitle: '🏆 Ganaste el torneo',
  otLostFinalTitle: 'Perdiste la final',
  otFinishedTitle: 'Torneo terminado',
  otInProgressTitle: 'Torneo',
  otEliminatedSub: 'Podés espectar las otras partidas',
  otSemiWonTitle: 'Semifinal ganada',
  otWaitingFinalist: 'Esperando al otro finalista…',
  otChampionSub: 'Campeón: {dot} <b>{name}</b>',
  otSemi1Label: 'Semifinal 1',
  otSemi2Label: 'Semifinal 2',
  otFinalLabel: 'Final',
  otSpectateBtn: '👁 Espectar',
  specConnecting: 'Conectando…',
  specMatchWon: '🏁 Ganó {name}',
  specCpuVsCpu: '🤖 Partida entre CPUs — se resuelve sola…',
  specDuelInProgress: '⚔️ ¡Duelo en curso!',
  specDuelTie: '🤝 Empate ({scoreA}-{scoreB})',
  specDuelWon: '⚔️ Ganó {name} ({scoreA}-{scoreB})',
  specTurn: 'Turno {n}',
  specWaitingData: 'Esperando datos…',
  otTagYou: 'vos',
  otTagHost: 'anfitrión',
  otTagCpu: 'CPU',
  otSlotFree: '— libre —',
  otSlotFreeTag: 'CPU al iniciar',
  campaignStartConfirm: '¿Comenzar campaña como <b>{name}</b>?',
  campaignToBeContinued: 'Continuará…',
  waitTextCpuFill: 'Los lugares libres se completan con CPUs',
  waitTextHostWillStart: 'Esperando que el anfitrión inicie…',

  // --- Textos antes hardcodeados en JS (v0.3.16, i18n) ---
  btnCampaign: 'Campaña',
  btnCampaignContinue: '▶ Continuar campaña',
  userTitleRegister: 'Creá tu <b>usuario</b>',
  userTitleLogin: 'Iniciar <b>sesión</b>',
  userBtnRegister: 'Crear cuenta',
  userBtnLogin: 'Entrar',
  userBtnCreatePassword: 'Crear contraseña',
  userSwitchToLogin: '¿Ya tenés usuario? Iniciá sesión',
  userSwitchToRegister: '¿No tenés usuario? Creá uno',
  userSwitchOther: 'Entrar con otro usuario',
  btnRematch: 'Revancha',
  bracketTitleStart: '¡Comienza el torneo!',
  bracketTitleNext: 'Próximo combate',
  userTooltipNamed: 'Usuario: {name}',
  userTooltipCreate: 'Crear usuario',
  homeFootDemo: 'Modo práctica activo. Conectá Firebase para jugar online con un amigo.',
  homeFootOnline: 'Online activo · creá una sala y pasá el código.',
};

// ===== 🌐 Idioma (v0.3.16) =====
// Traducciones al inglés de TEXTS_ES. Claves ausentes acá (p.ej. nombres
// propios de personajes: rosterNameX, cpuNamesPool, oppNamePractice,
// campaignOpp1Name) se dejan sin traducir a propósito — son nombres, no
// cambian entre idiomas. TEXTS_ES sigue siendo la base editable desde
// /admin/ (los overrides remotos solo aplican en español, ver refreshTexts()).
const TEXTS_EN = {
  abandonFlavorPool: 'Seems like you\'re intimidating\nThey got scared\nSomeone called them for dinner',
  toastOpponentWaiting: 'Opponent disconnected… waiting for reconnection',
  msgOpponentWaiting: '⚠️ Opponent disconnected — waiting…',
  toastOpponentBack: 'Opponent reconnected ✓',
  toastTourneyOppLeft: 'Your rival left — you advance',
  resultAbandonNote: '(by forfeit…)',
  resultVictoryTitle: 'VICTORY',
  toastSeriesOppLeft: 'Your rival left the series.',
  toastRoomOppLeft: 'Your rival left the room.',
  toastRoomClosed: 'The room was closed.',
  toastIdleAutoMove: 'You moved automatically due to inactivity ({streak}/{max})',
  toastIdleForfeit: 'You were disconnected for inactivity — you lost the match.',
  toastOppAutoMove: '⏱️ Your rival took too long — moved automatically ({streak}/{max})',
  toastOppGoneAuto: '📡 Rival disconnected — the game continues on its own',
  toastMoveError: 'Error sending move.',

  howtoTitle: 'How to play',
  howtoText: 'Move around the board. Grab swords and shields, and avoid the crosses. When you meet your rival, duel.',
  howtoLegendAtk: '+damage next duel',
  howtoLegendDef: '+defense next duel',
  howtoLegendDown: 'direct damage',
  howtoHint: 'In the duel: stop the needle in the green zone.',

  infoIntro: 'Move one tile per turn (diagonals included). Both players choose and move at the same time. Goal: reach the duel with an advantage and empty your rival\'s health.',
  infoItemDmg: '<b>Damage power.</b> Adds damage to your hits. It stacks.',
  infoItemDef: '<b>Defense power.</b> Reduces the damage you take. It also stacks.',
  infoItemTrap: '<b>Trap.</b> Costs you health if you step on it, but it never kills you. Better to avoid it.',
  infoItemRing: '<b>Ring.</b> Rare. Heals a lot at once if you\'re badly hurt, or bit by bit over several rounds if not.',
  infoDuelIntro: 'When you meet your rival, a reflex duel starts: stop the needle in the best possible zone.',
  infoZoneGreen: '<b>Green</b> — good hit.',
  infoZoneYellow: '<b>Yellow</b> — medium hit.',
  infoZoneOrange: '<b>Orange</b> — weak hit.',
  infoZoneRed: '<b>Red</b> — almost no damage.',
  infoPerfect: 'In the center of the green there\'s a thin strip: the <b>PERFECT</b>. It\'s worth double and doubles your damage power, but only on the <b>first pass</b>.',
  infoPerfectCancels: 'A PERFECT <b>cancels your rival\'s powers</b> if they didn\'t also land a perfect.',
  infoScoreDecay: 'The more passes it takes you to stop, the less red is worth. The higher score wins; the loser still deals some damage.',
  infoMercy: 'Winning a duel or stepping on a trap never kills you: only <b>losing</b> a duel can. Shared item: even coin flip.',
  infoWalls: '<b>Walls Mode</b> (beta): bigger map with walls that block straight passage, can be bordered diagonally. In the offline menu or with the 🧱 online toggle (not in the 4-player tournament).',

  toastRingBig: '{ring} {who} +{heal} HP',
  toastRingDrip: '{ring} {who} +{heal} HP x{rounds}',
  toastTourneyFinal: 'To the final! ⚔️',
  toastNeedConnection: 'The online tournament needs a connection.',
  toastCreateRoomFirst: 'Create the room first.',
  toastChangeModeBeforeJoin: 'Change the mode before your rival joins.',
  toastTourneyFull: 'There are already players in the tournament.',
  toastTourneyStartFail: 'Could not start the tournament.',
  toastCreateRoomFail: 'Could not create the room. Check your connection.',
  waitTextWaitingOpp: 'Waiting for rival…',
  waitTextOppLeft: 'Your rival left — waiting for another…',
  waitTextPracticeAvailable: 'Practice mode available',
  userHintRegister: 'Unique and permanent, always lowercase. With a password you\'ll be able to log in from any device. Each match\'s nickname is chosen separately, as always.',
  userHintLogin: 'Log in with your username and password.',
  userHintSession: 'Session started. You can log in with this username from any device.',
  userHintNoPassword: 'Your username doesn\'t have a password yet. Create one to log in from another device (and to not lose it).',
  toastWallsNotOnlineTourney: 'Walls Mode isn\'t available in the online tournament.',
  toastChaosNotOnlineTourney: 'Chaos Mode isn\'t available in the online tournament.',
  chestGotAtk: '🎁 {name}: 🗡️ +damage',
  chestGotDef: '🎁 {name}: ◈ +defense',
  chestGotHeal: '🎁 {name}: +{hp} HP',
  chestTrap: '🎁 {name}: it was a trap!',
  chestTeleport: '🎁 {name}: teleport!',
  bombArmed: '💣 Bomb armed: get away!',
  bombExploded: '💥 BOOM!',
  bootsPicked: '👟 {name}: double step next turn',
  rpsCaption: 'Rock, paper, scissors for the item!',
  rpsWaitingOpp: 'Waiting for your rival…',
  rpsOppReady: 'Your rival already chose',
  rpsNoPickYou: '⏰ Time ran out — no pick',
  rpsWinnerLine: '{name} takes it',
  rpsTieLine: 'Tie! Luck decides…',
  infoChaos: '<b>Chaos Mode</b> (beta): surprise chests 🎁, portals 🌀, timed bombs 💣, high ground ⛰️ and double-step boots 👟. In the offline menu or with the 🌀 online toggle (not in the 4-player tournament).',
  toastLabAdminsOnly: 'The lab is admins-only.',
  toastCodeLength: 'The code is 4 characters.',
  toastPracticeMode: 'Practice mode: you play against the CPU.',
  toastRoomNotFound: 'That room doesn\'t exist.',
  toastRoomFull: 'The room is already full.',
  toastJoinFail: 'Could not join the room.',
  toastConnectionError: 'Connection error.',
  toastWaitForCode: 'Wait for the code to be generated.',
  toastLinkCopiedClipboard: 'Link copied to clipboard ✓',
  toastLinkCopied: 'Link copied ✓',
  toastYourLink: 'Your link: {url}',
  toastInviteDetected: 'Invite detected · pick your name and join',
  toastUserCreated: 'User "{user}" created ✓',
  toastSessionStarted: 'Session started: {user} ✓',
  toastPasswordCreated: 'Password created ✓',
  toastSessionClosed: 'Session closed',

  errUserFormat: 'Username: 3 to 15 characters, lowercase, numbers or _',
  errPassShort: 'The password needs at least 6 characters.',
  errUserTaken: 'That username already exists.',
  errCredentials: 'Incorrect username or password.',
  errAlreadyLoggedIn: 'You already logged in with a password.',
  errNoPassword: 'You don\'t have a password yet — create one first.',
  errNoUser: 'Create your username first.',
  errNoConnection: 'Connection error. Try again.',

  msgTruce: 'Truce 🛡️ — choose where to move',
  msgChooseCell: 'Choose an adjacent tile to move to',
  msgOppChoseFirst: 'Your rival already chose — your turn to move',
  msgWaitingOpp: 'Waiting for rival…',
  msgMoving: 'Moving…',
  msgDuelImminent: 'Duel imminent…',
  msgRepositioning: 'Repositioning…',

  bubbleYou: 'You',
  bubbleRival: 'Rival',

  duelPerfectPrefix: '<b style="color:var(--perfect)">PERFECT</b> · ',
  duelVerdictWin: '{perfectPrefix}<b style="color:var(--good)">WINS</b> {name}',
  duelVerdictLose: '{perfectPrefix}<b style="color:var(--bad)">WINS</b> {name}',
  duelVerdictTie: '<b style="color:var(--warn)">TIE</b>',
  duelTitleEncounter: 'Encounter!',
  duelTitleStopGreen: 'Stop in green',
  duelCountdownGo: 'GO!',
  duelResultTitle: 'Result',
  duelTieTitle: 'Tie',
  duelTieSub: 'Nobody loses health — both get ejected',
  duelWinTitle: 'You won the duel',
  duelLoseTitle: 'You lost the duel',
  duelPerfectSub: '⭐ PERFECT by {name}',
  duelPassLabel: 'pass {pass}/{max}',
  duelLastPassLabel: 'last pass',
  zoneNamePerfect: 'PERFECT',
  zoneNameGreen: 'Green',
  zoneNameYellow: 'Yellow',
  zoneNameOrange: 'Orange',
  zoneNameRed: 'Red',

  resultFinalEyebrow: 'Final',
  resultBo5Eyebrow: 'Best of 3 · {scoreYou}–{scoreOpp}',
  resultTieTitle: 'Tie',
  resultWinTitle: 'You won',
  resultLoseTitle: 'You lost',
  resultWinRoundTitle: 'You won the round',
  resultLoseRoundTitle: 'You lost the round',
  resultWinSeriesTitle: '🏆 You won the series',
  resultLoseSeriesTitle: 'You lost the series',
  resultScoreRounds: 'Rounds: <b>{scoreYou}</b> – <b>{scoreOpp}</b>',
  resultScoreHp: '<b>{youHp}</b> HP vs <b>{oppHp}</b> HP',
  campaignRetryLabel: 'Retry',
  tourneyChampionTitle: 'Champion!',
  tourneyChampionScore: 'You beat <b>{name}</b> and won the tournament with <b>{hp}</b> HP left.',
  tourneyRoundEyebrow: 'Rival {i}/{n}',
  tourneyBeatOpp: 'You beat {name}',
  tourneyHpLeft: 'You have <b>{hp}</b> HP left. Next rival is tougher and smarter.',
  tourneyEliminatedTitle: 'Eliminated',
  tourneyEliminatedScore: 'You made it to rival <b>{i}/{n}</b> ({name}).',
  tourneyRetryLabel: 'Retry rival',
  tourneyChampionEyebrow: '🏆 Tournament',
  tourneyEyebrow: 'Tournament',

  // --- Levels / EXP (v0.3.36) ---
  resultExpGain: '+{n} EXP',
  levelLabel: 'Level {n}',
  levelUpFlash: 'Level {n}!',
  expProgress: '{into} / {need} EXP',

  otChampionTitle: '🏆 You won the tournament',
  otLostFinalTitle: 'You lost the final',
  otFinishedTitle: 'Tournament finished',
  otInProgressTitle: 'Tournament',
  otEliminatedSub: 'You can spectate the other matches',
  otSemiWonTitle: 'Semifinal won',
  otWaitingFinalist: 'Waiting for the other finalist…',
  otChampionSub: 'Champion: {dot} <b>{name}</b>',
  otSemi1Label: 'Semifinal 1',
  otSemi2Label: 'Semifinal 2',
  otFinalLabel: 'Final',
  otSpectateBtn: '👁 Spectate',
  specConnecting: 'Connecting…',
  specMatchWon: '🏁 {name} won',
  specCpuVsCpu: '🤖 CPU vs CPU match — resolves itself…',
  specDuelInProgress: '⚔️ Duel in progress!',
  specDuelTie: '🤝 Tie ({scoreA}-{scoreB})',
  specDuelWon: '⚔️ {name} won ({scoreA}-{scoreB})',
  specTurn: 'Turn {n}',
  specWaitingData: 'Waiting for data…',
  otTagYou: 'you',
  otTagHost: 'host',
  otTagCpu: 'CPU',
  otSlotFree: '— free —',
  otSlotFreeTag: 'CPU on start',
  campaignStartConfirm: 'Start the campaign as <b>{name}</b>?',
  campaignToBeContinued: 'To be continued…',
  waitTextCpuFill: 'Free slots are filled with CPUs',
  waitTextHostWillStart: 'Waiting for the host to start…',

  btnCampaign: 'Campaign',
  btnCampaignContinue: '▶ Continue campaign',
  userTitleRegister: 'Create your <b>username</b>',
  userTitleLogin: 'Log <b>in</b>',
  userBtnRegister: 'Create account',
  userBtnLogin: 'Log in',
  userBtnCreatePassword: 'Create password',
  userSwitchToLogin: 'Already have a username? Log in',
  userSwitchToRegister: 'No username yet? Create one',
  userSwitchOther: 'Log in with another username',
  btnRematch: 'Rematch',
  bracketTitleStart: 'The tournament begins!',
  bracketTitleNext: 'Next match',
  userTooltipNamed: 'User: {name}',
  userTooltipCreate: 'Create account',
  homeFootDemo: 'Practice mode active. Connect Firebase to play online with a friend.',
  homeFootOnline: 'Online active · create a room and share the code.',
};

// Idioma activo: 'es' (default) o 'en'. Se guarda en localStorage ('rally_lang')
// y se detecta del navegador si el jugador nunca lo eligió (index.html aplica
// esto mismo ANTES del primer paint para setear <html lang>; acá se replica
// la detección para que TEXTS arranque ya en el idioma correcto).
let LANG = 'es';
(function(){
  try{
    const stored = localStorage.getItem('rally_lang');
    if(stored==='es' || stored==='en'){ LANG = stored; return; }
  }catch(e){}
  const attr = document.documentElement.getAttribute('lang');
  if(attr==='es' || attr==='en'){ LANG = attr; return; }
  const nav = (navigator.language || 'en').toLowerCase();
  LANG = nav.indexOf('es')===0 ? 'es' : 'en';
})();

// TEXTS: copia de trabajo que lee el resto del juego (TEXTS.foo / fillText).
// Se repuebla desde TEXTS_ES (+ overrides de TEXTS_EN si LANG==='en') cada vez
// que cambia el idioma o llegan textos remotos. Los overrides de /admin/ solo
// tocan TEXTS_ES: el panel edita el texto en español, que es la fuente.
const TEXTS = {};
function refreshTexts(){
  for(const k in TEXTS_ES) TEXTS[k] = TEXTS_ES[k];
  if(LANG === 'en') for(const k in TEXTS_EN) TEXTS[k] = TEXTS_EN[k];
}
refreshTexts();

// Rellena {placeholders} de un texto con los valores dados: fillText('Hola {name}', {name:'Lucio'}) → 'Hola Lucio'.
// split/join en vez de replace(RegExp): un valor con '$&'/'$'' (p.ej. un nombre
// de jugador con '$') se interpretaba como patrón de reemplazo y rompía el texto.
function fillText(key, vars){
  let s = TEXTS[key] != null ? TEXTS[key] : key;
  if(vars) for(const k in vars) s = s.split('{'+k+'}').join(String(vars[k]));
  return s;
}
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
  spriteOpp: null,  // url de imagen para el marker del rival (sprite de campaña) o null
  spriteOppMove: null,  // url de imagen "en movimiento" del rival (o null: no hay variante)
  spriteYou: null,  // url de imagen para tu propia ficha (skin elegida en el perfil) o null
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

// Mantiene G.duel.trackWidth al día si el ancho del track cambia EN VIVO
// (rotación de pantalla, barra del navegador mobile que aparece/desaparece,
// zoom, split-screen): sin esto, el ancho quedaba cacheado fijo desde el
// arranque del duelo y la aguja se desalineaba de las zonas de color reales
// si el layout cambiaba a mitad de duelo (aguja "no fluida" / desincronizada).
let speedoResizeObserver = null;

function buildSpeedometer(){
  const ticksContainer = $('speedo-ticks');
  ticksContainer.innerHTML = '';

  for(let i=0; i<=10; i++){
    const tick = document.createElement('div');
    tick.className = 'speedo-tick' + (i % 5 === 0 ? ' is-major' : '');
    tick.style.left = (i * 10) + '%';
    ticksContainer.appendChild(tick);
  }
  // Ancho del track y referencias a las agujas cacheados UNA vez por duelo
  // (no en cada frame): las agujas se mueven con transform en updateNeedles()
  // en vez de `left`, que forzaba layout en cada frame del duelo (~60/seg) y
  // se veía trabado; lo mismo aplica a re-buscar los nodos por id.
  const track = ticksContainer.parentElement;
  G.duel.trackWidth = track.getBoundingClientRect().width;
  G.duel.needleYou = $('speedo-needle');
  G.duel.needleOpp = $('speedo-needle-opponent');

  if(typeof ResizeObserver !== 'undefined' && !speedoResizeObserver){
    speedoResizeObserver = new ResizeObserver(entries=>{
      G.duel.trackWidth = entries[0].contentRect.width;
    });
    speedoResizeObserver.observe(track);
  }
}

// Mueve una aguja a `pos` (0..1) del track sin tocar `left` (layout) — dos
// translateX encadenados: el primero la ubica en píxeles, el segundo la
// centra sobre ese punto (mismo resultado visual que left:X%+translateX(-50%),
// pero compositado por GPU).
function setNeedleX(el, pos, trackW){
  el.style.transform = `translateX(${pos * trackW}px) translateX(-50%)`;
}

// Maneja ambas agujas. En online, la del rival aparece sólo cuando llega su
// posición por Firebase (efecto "revelado con delay").
function updateNeedles(currentPos){
  const needleYou = G.duel.needleYou;
  const needleOpp = G.duel.needleOpp;
  const trackW = G.duel.trackWidth;

  // Aguja del jugador
  if(G.duel.yourStopped){
    setNeedleX(needleYou, G.duel.yourStoppedPos, trackW);
    needleYou.style.opacity = '1';
  } else {
    setNeedleX(needleYou, currentPos, trackW);
    needleYou.style.opacity = '1';
  }

  // Aguja del rival
  if(G.online){
    // Online: oculta hasta que el rival frenó (su dato llegó por Firebase).
    if(G.duel.oppStopped){
      setNeedleX(needleOpp, G.duel.oppStoppedPos, trackW);
      needleOpp.style.opacity = '0.45';
    } else {
      needleOpp.style.opacity = '0';   // todavía no sabemos dónde frenó
    }
  } else {
    // Offline (vs CPU): la aguja acompaña hasta que la CPU frena.
    if(G.duel.oppStopped){
      setNeedleX(needleOpp, G.duel.oppStoppedPos, trackW);
      needleOpp.style.opacity = '0.45';
    } else {
      setNeedleX(needleOpp, currentPos, trackW);
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
  // Modo Caos: cofres, bombas, terreno alto + un par de portales enlazados.
  if(App.chaosMode){
    placeRandom('chest', CFG.chestCount);
    placeRandom('bomb', CFG.bombCount);
    placeRandom('high', CFG.highCount);
    placeRandom('boots', CFG.bootsCount);
    placeRandom('portal', 2);
    // Los portales van SIEMPRE de a dos: si no entraron ambos, no va ninguno.
    if(countItems('portal') !== 2){
      G.board.forEach(c=>{ if(c.type==='portal') c.type='empty'; });
    }
  }
}
function cellAt(x,y){ return G.board[y*CFG.boardSize + x]; }
function countItems(type){ return G.board.filter(c => c.type === type).length; }

// ---- Serialización del tablero para online ----
const CELL_CODE = { empty:'e', power_dmg:'a', power_def:'d', down:'x', ring:'r', chest:'c', portal:'p', bomb:'b', bomb_armed:'B', high:'h', boots:'o' };
const CODE_CELL = { e:'empty', a:'power_dmg', d:'power_def', x:'down', r:'ring', c:'chest', p:'portal', b:'bomb', B:'bomb_armed', h:'high', o:'boots' };
function serializeBoard(){
  const cells = G.board.map(c => CELL_CODE[c.type] || 'e').join('');
  // En modo Paredes anteponemos tamaño y paredes: "W<size>~<paredes>~<celdas>".
  // Separador de campos "~" (las claves de pared contienen "|" y ",", no "~").
  if(App.wallsMode){
    return `W${CFG.boardSize}~${Walls.serialize()}~${cells}`;
  }
  // Modo Caos: prefijo "C~" para que el guest active el modo al deserializar
  // (mismo truco que Paredes: el modo viaja en el board, no toca game/mode).
  if(App.chaosMode){
    return `C~${cells}`;
  }
  return cells;
}
function deserializeBoard(str){
  // ¿Formato Modo Caos? "C~<celdas>" (tablero normal 7x7, ítems nuevos)
  if(typeof str==='string' && str[0]==='C' && str[1]==='~'){
    enterChaosMode();
    const cells = str.slice(2);
    const n = CFG.boardSize;
    G.board = [];
    for(let y=0; y<n; y++) for(let x=0; x<n; x++){
      const ch = cells[y*n + x] || 'e';
      G.board.push({ x, y, type: CODE_CELL[ch] || 'empty' });
    }
    return;
  }
  // ¿Formato con paredes? "W<size>~<paredes>~<celdas>"
  if(typeof str==='string' && str[0]==='W'){
    const firstSep = str.indexOf('~');
    const secondSep = str.indexOf('~', firstSep+1);
    const size = parseInt(str.slice(1, firstSep), 10) || CFG.wallsBoardSize;
    const wallsStr = str.slice(firstSep+1, secondSep);
    const cells = str.slice(secondSep+1);
    App.wallsMode = true;
    App.chaosMode = false;
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
  App.chaosMode = false;
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
  // Modo Caos: reponer cofres y bombas hasta su cantidad inicial (las armadas
  // cuentan para el cap; portales y terreno alto son fijos)
  if(App.chaosMode && countItems('chest') < CFG.chestCount){
    const cp=findEmpty(); if(cp) cellAt(cp.x,cp.y).type='chest';
  }
  if(App.chaosMode && (countItems('bomb') + countItems('bomb_armed')) < CFG.bombCount){
    const bp=findEmpty(); if(bp) cellAt(bp.x,bp.y).type='bomb';
  }
  if(App.chaosMode && countItems('boots') < CFG.bootsCount){
    const op=findEmpty(); if(op) cellAt(op.x,op.y).type='boots';
  }
  // Anillo multicolor: una vez por partida, raro, avanzada la partida, NO en torneo
  if(!Tourney.active && !G.ringSpawned && G.turnCount>=CFG.ringMinTurn && Math.random()<CFG.ringChancePerTurn){
    const rp=findEmpty();
    if(rp){ cellAt(rp.x,rp.y).type='ring'; G.ringSpawned=true; }
  }
  Sound.regen();
}

// ---- 🎨 Skins de la ficha propia (perfil, solo usuarios registrados) ----
// Catálogo de fichas seleccionables. `sprite:null` = bola sólida por defecto
// (el color de siempre, --accent). Cada otra entrada trae una imagen webp que
// se pinta sobre el marker vía la clase .has-sprite (mismo mecanismo que el
// sprite del rival de campaña). Para sumar una skin: agregar acá + subir el webp.
const SKINS = [
  { id:'default', name:'Clásica', nameEn:'Classic', sprite:null },
  { id:'malla',   name:'Malla',   nameEn:'Malla',   sprite:'sprites/malla.webp' },
  { id:'sumi',    name:'Sumi',    nameEn:'Sumi',    sprite:'sprites/sumi.webp' },
  { id:'kai',     name:'Kai',     nameEn:'Kai',     sprite:'sprites/kai.webp' },
];
// Perfil cosmético del jugador. La skin se guarda en localStorage (aplica al
// instante, incluso offline) y, si hay sesión, también en users/{uid}/skin para
// que siga a la cuenta entre dispositivos. Solo se APLICA a la ficha si el
// jugador está registrado (ver resolveSkins) — la elección es una perk de cuenta.
const Profile = {
  skin: 'default',
  load(){
    try{ const s=localStorage.getItem('rally_skin'); if(s && SKINS.some(k=>k.id===s)) this.skin=s; }catch(e){}
  },
  cur(){ return SKINS.find(k=>k.id===this.skin) || SKINS[0]; },
  sprite(){ return this.cur().sprite; },
  // sprite de una skin por id (para pintar la ficha del rival online). null si
  // no existe o es la clásica.
  spriteFor(id){ const s=SKINS.find(k=>k.id===id); return (s && s.sprite) || null; },
  setSkin(id){
    if(!SKINS.some(k=>k.id===id)) return;
    this.skin=id;
    try{ localStorage.setItem('rally_skin', id); }catch(e){}
    const cu = User.current();
    if(cu && fbDb) fbDb.ref('users/'+cu.uid+'/skin').set(id).catch(()=>{});
  },
  // Trae la skin guardada en la cuenta (al abrir el perfil ya logueado). Firebase
  // gana sobre localStorage: es la fuente de verdad de la cuenta.
  async loadRemote(){
    const cu = User.current();
    if(!cu || !fbDb) return;
    try{
      const v = (await fbDb.ref('users/'+cu.uid+'/skin').get()).val();
      if(v && SKINS.some(k=>k.id===v)){ this.skin=v; try{ localStorage.setItem('rally_skin', v); }catch(e){} }
    }catch(e){}
  },
};

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
  // Skin de la ficha propia: solo si el jugador está registrado (perk de cuenta).
  // El emoji del easter egg Messi tiene prioridad en el render (ver renderBoard).
  G.spriteYou = User.name ? Profile.sprite() : null;
  // Skin del rival en online: la elección que nos mandó por la sala (App.oppSkin).
  // El sprite de campaña lo setea applyOppCosmetic; online siempre lo dejó en null,
  // así que acá pintamos la ficha del rival con SU skin elegida. El emoji del
  // easter egg (G.skinOpp) tiene prioridad: si está seteado, no pisamos con el
  // sprite (renderBoard pinta el sprite antes que el emoji).
  if(App.online && !G.skinOpp){
    G.spriteOpp = Profile.spriteFor(App.oppSkin);
    // Precarga/decode del sprite del rival ACÁ (arranque de la partida), no en su
    // primer paint: la skin online no pasa por preloadSpriteAssets, así que sin
    // esto el decode del webp (~30KB) caía en cualquier momento — si aterrizaba
    // durante un duelo, el stall del main thread trababa el rAF de la aguja
    // (misma familia que v0.3.28). Con el decode adelantado al inicio, ya está
    // en caché mucho antes del primer duelo. Sin duelo tan temprano no molesta.
    if(G.spriteOpp) new Image().src = G.spriteOpp;
  }
}

// Ícono de ítem de una celda (compartido por el tablero real y el del espectador de OT).
function appendCellItemIcon(div, type){
  if(type === 'power_dmg'){ const s=document.createElement('span'); s.className='item-atk'; s.textContent='🗡️'; div.appendChild(s); }
  else if(type === 'power_def'){ const s=document.createElement('span'); s.className='item-def'; s.textContent='◈'; div.appendChild(s); }
  else if(type === 'down'){ const s=document.createElement('span'); s.className='down'; s.textContent='×'; div.appendChild(s); }
  else if(type === 'ring'){ const s=document.createElement('span'); s.className='item-ring'; div.appendChild(s); }
  else if(type === 'chest'){ const s=document.createElement('span'); s.className='item-chest'; s.textContent='🎁'; div.appendChild(s); }
  else if(type === 'portal'){ const s=document.createElement('span'); s.className='item-portal'; s.textContent='🌀'; div.appendChild(s); }
  else if(type === 'bomb'){ const s=document.createElement('span'); s.className='item-bomb'; s.textContent='💣'; div.appendChild(s); }
  else if(type === 'bomb_armed'){ const s=document.createElement('span'); s.className='item-bomb is-armed'; s.textContent='💣'; div.appendChild(s); }
  else if(type === 'high'){ const s=document.createElement('span'); s.className='item-high'; s.textContent='⛰️'; div.appendChild(s); }
  else if(type === 'boots'){ const s=document.createElement('span'); s.className='item-boots'; s.textContent='👟'; div.appendChild(s); }
}

function renderBoard(){
  const boardEl = $('board'); boardEl.innerHTML = '';
  const n = CFG.boardSize;
  boardEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  boardEl.classList.toggle('is-large', n >= 9);
  const youRange = (App.chaosMode && G.you.boots) ? CFG.bootsRange : 1;   // 👟 doble paso
  const reachable = G.phase === 'choose' ? getReachable(G.you.x, G.you.y, youRange) : [];
  const reachSet = new Set(reachable.map(p=>p.x+','+p.y));   // lookup O(1) por celda
  // 💣 Área de las bombas armadas: aviso sutil en las casillas afectadas
  const blastWarn = new Set();
  if(App.chaosMode){
    G.board.forEach(c=>{
      if(c.type==='bomb_armed') bombArea(c.x, c.y).forEach(a=>blastWarn.add(a.x+','+a.y));
    });
  }
  // Recorremos en orden VISUAL. Para cada celda visual, hallamos su coord canónica.
  // Las celdas se arman en un fragment y se insertan al DOM vivo de una sola vez.
  const frag = document.createDocumentFragment();
  for(let vy=0; vy<n; vy++){
    for(let vx=0; vx<n; vx++){
      // viewCoord es involutiva: visual->canónica usa la misma transformación
      const cn = viewCoord(vx, vy);
      const x = cn.x, y = cn.y;
      const cell = cellAt(x,y);
      const div = document.createElement('div'); div.className = 'cell'; div.dataset.x = x; div.dataset.y = y;
      if(blastWarn.has(x+','+y)) div.classList.add('is-blast-warn');
      appendCellItemIcon(div, cell.type);
      const youHere = (G.you.x === x && G.you.y === y);
      const oppHere = (G.opp.x === x && G.opp.y === y);
      const shielded = G.justDueled;   // tregua post-duelo: burbuja visible
      const bothHere = youHere && oppHere;
      if(bothHere) div.classList.add('is-both-here');
      if(youHere){
        const m=document.createElement('div'); m.className='player-marker is-you';
        if(shielded) m.classList.add('has-shield');
        if(G.skinYou){ m.classList.add('has-skin'); m.textContent=G.skinYou; }
        else if(G.spriteYou){ m.classList.add('has-sprite'); m.style.setProperty('--sprite-url', `url(${G.spriteYou})`); }
        if(bothHere) m.classList.add('is-clash');
        div.appendChild(m);
      }
      if(oppHere){
        const m=document.createElement('div'); m.className='player-marker is-opp';
        if(shielded) m.classList.add('has-shield');
        if(G.spriteOpp){ m.classList.add('has-sprite'); m.style.setProperty('--sprite-url', `url(${G.spriteOpp})`); }
        else if(G.skinOpp){ m.classList.add('has-skin'); m.textContent=G.skinOpp; }
        if(bothHere) m.classList.add('is-clash');
        div.appendChild(m);
      }
      if(reachSet.has(x+','+y)){
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
      frag.appendChild(div);
    }
  }
  boardEl.appendChild(frag);
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

// range opcional (default 1): las botas 👟 del Modo Caos habilitan radio 2 por
// un turno. Solo el paso adyacente chequea paredes — Caos y Paredes son
// mutuamente excluyentes, así que el radio 2 nunca convive con paredes.
function getReachable(x, y, range){
  const r = range || 1;
  const n = CFG.boardSize, out = [];
  for(let dy=-r; dy<=r; dy++) for(let dx=-r; dx<=r; dx++){
    if(dx===0&&dy===0) continue;
    const nx=x+dx, ny=y+dy;
    if(nx>=0&&nx<n&&ny>=0&&ny<n){
      if(Math.max(Math.abs(dx),Math.abs(dy))===1 && Walls.blocks(x, y, nx, ny)) continue;
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
  spawnStartBubble('.player-marker.is-you', TEXTS.bubbleYou, 'is-you');
  spawnStartBubble('.player-marker.is-opp', showGenericRival ? TEXTS.bubbleRival : App.oppName, 'is-opp');
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
  // Tablero fijo de campaña (editor de mapas): el nodo trae el board serializado
  // (formato clásico o "W<size>~…" con paredes — deserializeBoard resuelve ambos
  // y setea CFG.boardSize/App.wallsMode). Sin board: aleatorio como siempre.
  const fixedBoard = Campaign.active && Campaign.cur() && Campaign.cur().board;
  if(typeof fixedBoard === 'string' && fixedBoard.length){
    deserializeBoard(fixedBoard);
    // Las esquinas son posiciones de arranque: vaciarlas por las dudas
    const nn = CFG.boardSize;
    cellAt(0,0).type='empty'; cellAt(nn-1,nn-1).type='empty';
  } else {
    // Si el nodo ANTERIOR de la campaña era un mapa con paredes, este no lo es:
    // volver al tablero normal antes de generar (fuera de campaña no aplica —
    // el modo Paredes de partida rápida usa wallsMode a propósito).
    if(Campaign.active && (App.wallsMode || App.chaosMode)) exitSpecialMode();
    buildBoard();
  }
  const n=CFG.boardSize;
  const oppHp = Campaign.active ? (Campaign.matchOpt('hp') || CFG.maxHp)
              : Tourney.active  ? tourneyHpFor(Tourney.index) : CFG.maxHp;
  // En torneo, el jugador conserva la vida entre rondas (salvo al empezar/reintentar)
  const youHp = Campaign.active ? ((Campaign.cur() && Campaign.cur().youHp) || CFG.maxHp)
              : Tourney.active  ? (Tourney._carryHp!=null ? Tourney._carryHp : TOURNEY_YOU_HP)
              : CFG.maxHp;
  // maxHp propio del jugador: el HUD/curas escalan con esto (torneo sigue en 100)
  const youMax = Campaign.active ? Math.max(youHp, CFG.maxHp)
               : Tourney.active  ? TOURNEY_YOU_HP : CFG.maxHp;
  G.you = {x:n-1,y:n-1,hp:youHp,maxHp:youMax,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
  G.opp = {x:0,y:0,hp:oppHp,maxHp:oppHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
  G.turnCount = 0; G.justDueled = false; G.running = true; G.ringSpawned=false; G.you.ringDrip=0; G.opp.ringDrip=0; G.bombs=[]; G.rps=null; G._oppAutoStreak=0; clearNetDeadlines();
  HudFx.you=null; HudFx.opp=null;   // feedback de daño del HUD: sin previo al arrancar
  resolveSkins();   // easter egg Messi (offline: solo aplica tu propia skin)
  updateHud(); renderBoard(); startChoosePhase();
  showStartBubbles();
}

// Etapa 2: arranque sincronizado. Ambos clientes comparten el mismo board.
// role: 'host' (ficha en 6,6 canónico) o 'guest' (ficha en 0,0, vista espejada).
function startOnlineGame(boardStr, role){
  G.online = true;
  G.flip = (role === 'guest');
  G._idleAutoStreak = 0;   // racha de auto-movimientos por inactividad, por partida
  deserializeBoard(boardStr);        // esto define CFG.boardSize (7 normal, 9 paredes)
  const n = CFG.boardSize;           // leer DESPUÉS de deserializar
  document.documentElement.style.removeProperty('--opp-accent'); // rival neutro online
  if(role === 'host'){
    G.you = {x:n-1,y:n-1,hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
    G.opp = {x:0,  y:0,  hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
  } else {
    G.you = {x:0,  y:0,  hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:0,prevY:0,buffs:{dmg:0,def:0}};
    G.opp = {x:n-1,y:n-1,hp:CFG.maxHp,maxHp:CFG.maxHp,prevX:n-1,prevY:n-1,buffs:{dmg:0,def:0}};
  }
  G.turnCount = 0; G.justDueled = false; G.running = true; G.ringSpawned=false; G.you.ringDrip=0; G.opp.ringDrip=0; G.bombs=[]; G.rps=null; G._oppAutoStreak=0; clearNetDeadlines();
  HudFx.you=null; HudFx.opp=null;   // feedback de daño del HUD: sin previo al arrancar
  resolveSkins();   // easter egg Messi: define skins/nombre según ambos jugadores
  show('game');
  updateHud(); renderBoard();

  // Listener: cuando el host regenera items, el guest recibe el board nuevo.
  // Actualiza solo los tipos de celda, nunca las posiciones de jugadores.
  Net.onBoardUpdate = (boardStr)=>{
    // Soporta formato con paredes ("W<size>|<paredes>|<celdas>"): solo cambian
    // los ítems, así que extraemos la parte de celdas. Las paredes no varían.
    // Idem Modo Caos ("C~<celdas>").
    let cells = boardStr;
    if(typeof boardStr==='string' && boardStr[0]==='W'){
      const i2 = boardStr.indexOf('~', boardStr.indexOf('~')+1);
      cells = boardStr.slice(i2+1);
    } else if(typeof boardStr==='string' && boardStr[0]==='C' && boardStr[1]==='~'){
      cells = boardStr.slice(2);
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
  Net.onOpponentWaiting = ()=>{ toast(TEXTS.toastOpponentWaiting); setMsg(TEXTS.msgOpponentWaiting, true); };
  Net.onOpponentBack = ()=>{ toast(TEXTS.toastOpponentBack); };
  Net.startPresence();

  // v0.3.41: fin unilateral — si el rival me declaró inactivo mientras yo no
  // estaba, el marcador game/over me muestra la derrota apenas vuelvo.
  Net.onGameOver = onGameOverMarker;
  Net.listenGameOver();
  // Guest 1v1: sala borrada en pleno running = el host salió deliberadamente
  // (sin marcador) → victoria inmediata. En OT lo cubre el watcher de players.
  if(Net.role==='guest' && !OT.active){
    Net.onRoomGone = ()=>{ if(G.running && G.online) winByAbandon(); };
    Net.listenRoomAlive();
  }

  // Chat en vivo (solo online): monta el panel y escucha mensajes.
  Chat.mount();

  // Etapa 3A: arrancamos la fase de elección con movimientos sincronizados.
  startChoosePhase();
  showStartBubbles();
}

// El rival se fue DE VERDAD → victoria por abandono. v0.3.41: ya no lo dispara
// la caída de presencia sola (ver onOpponentLeft) — llega por salida deliberada
// (nodo guest/sala borrados), por racha de auto-movimientos (endByOppIdle) o
// fuera de partida por el camino de siempre.
function winByAbandon(){
  if(!G.online || G.phase==='gameover') return;
  G.running=false; G.phase='gameover'; G.online=false;
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  setDuelOverlayShown(false);
  hideRpsOverlay();   // el rival pudo irse en pleno piedra-papel-tijera/ruleta
  clearNetDeadlines();
  if(OT.active && OT.inMatch){
    toast(TEXTS.toastTourneyOppLeft);
    OT.onMyMatchEnd(Math.max(1, G.you.hp), 0);
    return;
  }
  const abandonFlavors = TEXTS.abandonFlavorPool.split('\n').map(s=>s.trim()).filter(Boolean);
  const msg = abandonFlavors[Math.floor(Math.random()*abandonFlavors.length)];
  $('result-eyebrow').textContent=TEXTS.resultFinalEyebrow;
  $('result-title').textContent=TEXTS.resultVictoryTitle;
  $('result-title').classList.remove('is-lose'); $('result-title').classList.add('is-win');
  $('result-score').innerHTML=`<span style="color:var(--muted)">${TEXTS.resultAbandonNote}</span><br><br>${msg}`;
  $('btn-tourney-next').style.display='none';
  $('btn-to-room').style.display='none';
  $('btn-again').style.display='none';   // no hay revancha en abandono online
  showResultExp(grantBattleExp('win', 'online'));   // ganar por abandono también cuenta
  show('result');
}

// La presencia del rival venció su gracia de reconexión. v0.3.41: con la
// partida EN CURSO ya no es fatal (antes cortaba acá y el reloj global nunca
// llegaba a actuar) — la partida sigue sola con los fallbacks y el fin llega
// por racha de 3 auto-movimientos (endByOppIdle), salida deliberada o KO.
// Fuera de partida (pantallas de resultado) conserva el comportamiento viejo.
function onOpponentLeft(){
  if(!G.online || G.phase==='gameover') return;
  if(G.running){ toast(TEXTS.toastOppGoneAuto); return; }
  winByAbandon();
}

// Llegó el marcador game/over (v0.3.41): la partida terminó unilateralmente
// por inactividad. Si el ganador soy yo, ya mostré la victoria (yo lo escribí).
// Si no, soy el desconectado que volvió: derrota inmediata — aunque mi pantalla
// estuviera reviviendo la partida por catch-up, esto la corta (guards
// !G.running en todas las cadenas, lección v0.3.27).
function onGameOverMarker(over){
  if(!over || !over.winner) return;
  Net._keepRoom = true;   // la sala sobrevive al leave: el otro tiene que poder leerlo
  if(over.winner === myAbsRole()) return;
  if(!G.online || G.phase==='gameover') return;
  if(OT.active && OT.inMatch){
    G.running=false;
    if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
    setDuelOverlayShown(false); hideRpsOverlay(); clearNetDeadlines();
    toast(TEXTS.toastIdleForfeit);
    OT.onMyMatchEnd(0, Math.max(1, G.opp.hp));
    return;
  }
  forfeitByIdle();   // misma UX que el forfeit local: limpieza + home + toast
}
function startChoosePhase(){
  G.phase='choose'; G.yourMove=null; G.oppMove=null;
  if(OT.active && OT.inMatch && OT.master) OT.pushSpec();
  if(G.justDueled && areAdjacentOrSame(G.you, G.opp)){
    setMsg(TEXTS.msgTruce, true);
  } else {
    setMsg(TEXTS.msgChooseCell, true);
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
        setMsg(TEXTS.msgOppChoseFirst, true);
      }
    };
    Net.listenMoves(G.turnCount);
    // Auto-movimiento por inactividad: solo 1v1/torneo online contra un
    // rival humano real (nunca en torneo x4 contra CPU de relleno, que
    // igual ya deja G.online en false para esos casos).
    if(!(OT.active && OT.inMatch)) startIdleTimer();
  }
}

function onPlayerMove(x, y, isAuto){
  if(G.phase!=='choose') return;
  clearIdleTimers();
  // Elegiste vos a tiempo: corta la racha de auto-movimientos consecutivos.
  if(G.online && !isAuto) G._idleAutoStreak = 0;
  G.yourMove={x,y};
  if(G.online){
    // Online: subir mi movimiento y esperar al rival
    G.phase='waiting-opp';
    setMsg(TEXTS.msgWaitingOpp, true);
    renderBoard();
    Net.pushMove(G.turnCount, x, y).catch(e=>{ console.error(e); toast(TEXTS.toastMoveError); });
    // Reloj global: si el move del rival nunca llega (pestaña de fondo → su
    // timer de inactividad está frenado), lo muevo yo a lo más conveniente y
    // el turno sigue. First-write-wins: si su move real entra antes que este
    // fallback, la transaction aborta sola y no pasa nada.
    const turn = G.turnCount;
    if(G._moveDeadline) clearTimeout(G._moveDeadline);
    G._moveDeadline = setTimeout(()=>{
      G._moveDeadline=null;
      if(!G.running || !G.online || G.phase!=='waiting-opp' || turn!==G.turnCount) return;
      const mv = bestConvenientMove(G.opp);
      Net.pushOppMoveFallback(turn, mv.x, mv.y).then(r=>{
        // committed=false: el move real del rival ganó la carrera → está vivo
        registerOppAutoMove(!!(r && r.committed));
      }).catch(e=>console.error('[net] move fallback', e));
    }, NET_MOVE_DEADLINE_MS);
    return;
  }
  // Offline: la CPU responde y se resuelve
  G.oppMove=cpuDecideMove();
  resolveMoves();
}

// ===== ⏱️ Auto-mover por inactividad (solo online, v0.2.96) =====
// Si no elegís casillero en 6s, te mueve solo al más conveniente. Al
// completarse 3 auto-movimientos seguidos (sin que elijas vos a tiempo en
// el medio), se te da por desconectado y el rival gana — reusando el MISMO
// flujo de abandono/presencia que ya existe (Net.leave() borra tu marca de
// presencia; el rival ya tiene armado onOpponentLeft() para ese caso, con
// su propio período de gracia), en vez de escribir una pantalla nueva.
const IDLE_REVEAL_MS = 3000;   // recién a partir de acá se ve la barra
const IDLE_TOTAL_MS = 6000;    // tiempo total antes del auto-movimiento
const IDLE_MAX_STREAK = 3;

function clearIdleTimers(){
  if(G._idleTimers) G._idleTimers.forEach(t=>clearTimeout(t));
  G._idleTimers = [];
  hideIdleBar();
}

function startIdleTimer(){
  clearIdleTimers();
  G._idleTimers.push(setTimeout(showIdleBar, IDLE_REVEAL_MS));
  G._idleTimers.push(setTimeout(()=>{
    const fill=$('idle-timer-fill');
    if(fill){ fill.classList.remove('is-green'); fill.classList.add('is-yellow'); }
  }, IDLE_REVEAL_MS + 1000));
  G._idleTimers.push(setTimeout(()=>{
    const fill=$('idle-timer-fill');
    if(fill){ fill.classList.remove('is-yellow'); fill.classList.add('is-red'); }
    const bar=$('idle-timer');
    if(bar) bar.classList.add('is-danger');
  }, IDLE_REVEAL_MS + 2000));
  G._idleTimers.push(setTimeout(autoMoveIdle, IDLE_TOTAL_MS));
}

function showIdleBar(){
  const bar=$('idle-timer'), fill=$('idle-timer-fill');
  if(!bar || !fill) return;
  fill.className = 'idle-timer__fill is-green';
  fill.style.transition = 'none';
  fill.style.width = '100%';
  bar.classList.add('is-show');
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      fill.style.transition = `width ${IDLE_TOTAL_MS - IDLE_REVEAL_MS}ms linear`;
      fill.style.width = '0%';
    });
  });
}

function hideIdleBar(){
  const bar=$('idle-timer'), fill=$('idle-timer-fill');
  if(!bar || !fill) return;
  bar.classList.remove('is-show','is-danger');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.className = 'idle-timer__fill is-green';
}

// Heurística simple para el auto-movimiento por inactividad: no reusa
// cpuDecideMove() porque esa está atada a conceptos de la IA offline
// (skill, rasgos de personaje, historial anti-vaivén) que no aplican acá.
function bestConvenientMove(me){
  const reachable = getReachable(me.x, me.y);
  const nonTrap = reachable.filter(p => cellAt(p.x,p.y).type !== 'down');
  const boxedIn = nonTrap.length === 0;
  const scored = reachable.map(p=>{
    const t = cellAt(p.x,p.y).type;
    let score = 0;
    if(t==='power_dmg') score += 6;
    else if(t==='power_def') score += 5;
    else if(t==='ring') score += 8;
    else if(t==='chest') score += 5;
    else if(t==='boots') score += 4;
    else if(t==='high') score += 1.5;
    else if(t==='empty') score += 1;
    else if(t==='down'){ score -= 14; if(boxedIn) score += 13; }
    if(App.chaosMode) score -= bombThreatAt(p.x, p.y);   // 💣 evitar el área de explosión
    score += Math.random() * 0.5;   // desempate suave
    return { x:p.x, y:p.y, score };
  });
  scored.sort((a,b)=>b.score-a.score);
  return scored[0];
}

function autoMoveIdle(){
  if(G.phase!=='choose' || !G.online) return;
  G._idleAutoStreak = (G._idleAutoStreak||0) + 1;
  const move = bestConvenientMove(G.you);
  onPlayerMove(move.x, move.y, true);
  if(G._idleAutoStreak >= IDLE_MAX_STREAK){
    setTimeout(forfeitByIdle, 400);
  } else {
    toast(fillText('toastIdleAutoMove', { streak:G._idleAutoStreak, max:IDLE_MAX_STREAK }));
  }
}

function forfeitByIdle(){
  if(!G.online) return;
  Net.leave();
  G.running=false; G.phase='idle'; G.online=false;
  Chat.unmount();
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  hideRpsOverlay();
  clearNetDeadlines();
  show('home');
  toast(TEXTS.toastIdleForfeit);
}

// ===== 🌐 Reloj global online (v0.3.40) =====
// Los avances online dependían de timers/rAF del OTRO cliente: con su pestaña
// de fondo el navegador se los frena (setTimeout throttled, rAF congelado) y
// la partida quedaba colgada aunque su presencia siguiera viva. Ahora el
// cliente PRESENTE arma un plazo de reloj de pared y, al vencer, escribe él
// mismo el dato faltante del rival en Firebase (move conveniente / score 0 de
// duelo / "no elección" de RPS / eject de empate). Todas esas escrituras son
// first-write-wins (Net._setIfAbsent): si el ausente escribe tarde, su valor
// pierde en silencio y AMBOS clientes resuelven con el dato canónico que
// quedó en Firebase — sin desync (lección v0.3.38).
const NET_MOVE_DEADLINE_MS  = 15000;  // > IDLE_TOTAL_MS + margen de throttling del rival
const NET_DUEL_GRACE_MS     = 5000;   // margen tras el largo máximo del duelo (el vivo comete 0 a los ~3.6s)
const NET_RPS_GRACE_MS      = 2500;   // margen tras el plazo de elección del RPS
const NET_EJECT_DEADLINE_MS = 4000;   // espera del guest por el eject del host

function clearNetDeadlines(){
  ['_moveDeadline','_duelDeadline','_ejectDeadline'].forEach(k=>{
    if(G[k]){ clearTimeout(G[k]); G[k]=null; }
  });
}

// Racha de auto-movimientos remotos del rival (v0.3.41): cada fallback de
// movimiento que COMETE (el rival no movió en 15s) suma; un move real suyo la
// corta. Al 3ro (IDLE_MAX_STREAK, mismo criterio que el idle local) la partida
// termina — así una desconexión tiene ~3 turnos de gracia para volver, en vez
// del corte abrupto por presencia de antes.
function registerOppAutoMove(committed){
  if(!G.running || !G.online) return;
  if(!committed){ G._oppAutoStreak = 0; return; }
  G._oppAutoStreak = (G._oppAutoStreak||0) + 1;
  if(G._oppAutoStreak >= IDLE_MAX_STREAK){ endByOppIdle(); return; }
  toast(fillText('toastOppAutoMove', { streak:G._oppAutoStreak, max:IDLE_MAX_STREAK }));
}

// Fin por inactividad del rival: el marcador game/over queda en Firebase
// (first-write-wins) para que el desconectado, cuando vuelva, vea su DERROTA
// en vez de una partida viva — sin doble ganador (bug del test en vivo v0.3.40).
function endByOppIdle(){
  if(!G.running || !G.online) return;
  // keepRoom acá mismo (no esperar el rebote del listener): si salgo de la
  // pantalla de victoria antes del roundtrip, la sala no se puede borrar.
  Net._keepRoom = true;
  Net.pushGameOver(myAbsRole()).catch(e=>console.error('[net] game over', e));
  winByAbandon();
}

// Online: llegaron ambos movimientos. Mapear según mi rol y resolver.
function onOnlineMovesReady(moves){
  // Deadline todavía armado = el rival movió él mismo antes de los 15s → vivo
  if(G._moveDeadline){ clearTimeout(G._moveDeadline); G._moveDeadline=null; G._oppAutoStreak=0; }
  if(G.phase!=='waiting-opp' && G.phase!=='choose') return;
  const mine  = (Net.role==='host') ? moves.host  : moves.guest;
  const other = (Net.role==='host') ? moves.guest : moves.host;
  G.yourMove = { x:mine.x,  y:mine.y  };
  G.oppMove  = { x:other.x, y:other.y };
  resolveMoves();
}

// 💣 Peligro de bomba para la IA: cuánto castigar pararse en (x,y).
// Inminente (explota en la PRÓXIMA resolución: detonateBombs usa el mismo
// turnCount que esta fase de elección) = casi el daño real; si falta mecha,
// castigo chico (puede pasar de largo).
function bombThreatAt(x, y){
  if(!App.chaosMode || !G.bombs || !G.bombs.length) return 0;
  let threat = 0;
  G.bombs.forEach(b=>{
    if(!bombArea(b.x, b.y).some(c=>c.x===x && c.y===y)) return;
    threat = Math.max(threat, (G.turnCount - b.armedTurn >= CFG.bombFuse) ? 12 : 3);
  });
  return threat;
}

function cpuDecideMove(){
  // 👟 Con botas, la CPU también elige en radio 2
  let reachable = getReachable(G.opp.x, G.opp.y, (App.chaosMode && G.opp.boots) ? CFG.bootsRange : 1);
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
  const lowHp = G.opp.hp <= cpuDesperateHp();            // % de su vida máxima
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
      else if(t==='ring') val = 7 + (((G.opp.maxHp||CFG.maxHp) - G.opp.hp)/(G.opp.maxHp||CFG.maxHp))*8;
      else if(t==='chest') val = 5;      // 🎁 en promedio conviene
      else if(t==='boots') val = 4;      // 👟 movilidad para el próximo turno
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
      const oppMax = G.opp.maxHp || CFG.maxHp;
      const missing = oppMax - G.opp.hp;                  // cuánta vida le falta
      score += 7 + (missing / oppMax) * 8;                // ~7 sana, hasta ~15 muy herida
      if(losing) score += 2;                              // extra si va perdiendo
    }
    if(cell.type === 'empty')     score += 1;   // base: moverse a vacío es bueno
    // 🌀 Modo Caos: valoración simple de los ítems nuevos
    if(cell.type === 'chest')  score += 5;      // 🎁 sorpresa: en promedio conviene
    if(cell.type === 'boots')  score += 4;      // 👟 doble paso
    if(cell.type === 'bomb')   score += 1;      // armarla puede ser jugada, sin regalarse
    if(cell.type === 'high')   score += 1.5;    // ⛰️ bonus si hay duelo
    if(cell.type === 'portal') score += 0.5;    // 🌀 movilidad
    if(App.chaosMode) score -= bombThreatAt(p.x, p.y);   // 💣 no pararse donde explota

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
  // Rival en movimiento: sprite "corriendo" mientras dura el deslizamiento,
  // vuelve al idle (G.spriteOpp) apenas termina. Solo aplica si el nodo de
  // campaña trae variante de movimiento (spriteOppMove); si no hay, el
  // marker se queda con el idle todo el trayecto, sin romper nada.
  const swapSprite = cls==='is-opp' && G.spriteOppMove && el.classList.contains('has-sprite');
  if(swapSprite) el.style.setProperty('--sprite-url', `url(${G.spriteOppMove})`);
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      // Curva propia para el deslizamiento (carga y llegada, sin rebote):
      // la de .player-marker en CSS es "back-out" (se usa para el pop de
      // choque, .is-clash) y pasa de largo antes de asentar. Al terminar,
      // se limpia la transition inline para no pisar esa otra animación.
      // (v0.3.32 probó un overshoot suave acá; a Lucio no le gustó — no volver.)
      el.style.transition = 'transform .35s ease-in-out';
      el.style.transform = '';
      el.addEventListener('transitionend', ()=>{
        el.style.transition = '';
        if(swapSprite && G.spriteOpp) el.style.setProperty('--sprite-url', `url(${G.spriteOpp})`);
      }, {once:true});
    });
  });
}

function resolveMoves(){
  G.phase='moving'; setMsg(TEXTS.msgMoving);
  G.you.prevX=G.you.x; G.you.prevY=G.you.y; G.opp.prevX=G.opp.x; G.opp.prevY=G.opp.y;
  // Historial de las últimas casillas de la CPU (solo offline; evita vaivén)
  if(!G.online){
    if(!G.opp.history) G.opp.history=[];
    G.opp.history.push(`${G.opp.x},${G.opp.y}`);
    if(G.opp.history.length>6) G.opp.history.shift();
  }
  // Modo Caos — portales: pisar uno te reubica en el gemelo. Las posiciones
  // FINALES se calculan ANTES del choque/FLIP para que choque, duelo y efectos
  // de casilla se evalúen sobre las posiciones ya teleportadas (determinista:
  // mismo board y mismos movimientos en ambos clientes). Si ambos entran al
  // MISMO portal es un choque normal ahí y nadie viaja; si entran a portales
  // distintos, se intercambian (cada gemelo es la entrada del otro).
  G._teleYou=false; G._teleOpp=false;
  let youDest={x:G.yourMove.x, y:G.yourMove.y}, oppDest={x:G.oppMove.x, y:G.oppMove.y};
  if(App.chaosMode && !(youDest.x===oppDest.x && youDest.y===oppDest.y)){
    const ty=portalTwin(youDest.x, youDest.y), to=portalTwin(oppDest.x, oppDest.y);
    if(ty){ youDest=ty; G._teleYou=true; }
    if(to){ oppDest=to; G._teleOpp=true; }
  }
  // Si ambos caen en la MISMA casilla, renderBoard() les aplica su propio
  // transform de choque (.is-clash) — no animamos ese caso puntual para no
  // pelear con ese offset ya afinado.
  const willClash = (youDest.x===oppDest.x && youDest.y===oppDest.y);
  const youOldRect = willClash ? null : getMarkerRect('is-you');
  const oppOldRect = willClash ? null : getMarkerRect('is-opp');
  G.you.x=youDest.x; G.you.y=youDest.y; G.opp.x=oppDest.x; G.opp.y=oppDest.y;
  // 👟 Doble paso: el buff cubría ESTE movimiento y se consume (lo haya usado
  // o no) ANTES de los efectos — pisar otras botas ahora lo re-otorga.
  if(App.chaosMode){ G.you.boots=false; G.opp.boots=false; }
  const sharedBuff = applySharedCellEffects();   // puede teleportar por cofre (flags G._tele*)
  applyRingDrip(G.you); applyRingDrip(G.opp);
  // 💣 Bombas con mecha vencida: detonar ANTES del render (piedad: no matan)
  const blastCells = App.chaosMode ? detonateBombs() : null;
  // La tregua se cumple en cuanto ambos se mueven: quitar la burbuja YA,
  // antes de redibujar, para que no quede un instante en la casilla nueva.
  const wasTruce = G.justDueled;
  G.justDueled = false;
  Sound.step(); haptic(10); renderBoard(); updateHud();
  // Los teleportados (portal o cofre) no se deslizan con FLIP: aparecen en
  // destino con su propio efecto visual (el próximo renderBoard limpia el fx).
  flipMarker('is-you', G._teleYou ? null : youOldRect);
  flipMarker('is-opp', G._teleOpp ? null : oppOldRect);
  if(G._teleYou || G._teleOpp){
    [[G._teleYou, G.you], [G._teleOpp, G.opp]].forEach(([tele, pl])=>{
      if(!tele) return;
      // data-x/data-y son canónicos (a prueba del espejo del guest)
      const cell = document.querySelector(`.cell[data-x="${pl.x}"][data-y="${pl.y}"]`);
      if(cell){ const fx=document.createElement('div'); fx.className='portal-fx'; cell.appendChild(fx); }
    });
    Sound.pickupDef && Sound.pickupDef(); haptic([10,25,10]);
  }
  // 💥 Flash one-shot en las casillas alcanzadas por una explosión
  if(blastCells){
    blastCells.forEach(c=>{
      const cell = document.querySelector(`.cell[data-x="${c.x}"][data-y="${c.y}"]`);
      if(cell){ const fx=document.createElement('div'); fx.className='bomb-fx'; cell.appendChild(fx); }
    });
    shakeBoard();
  }
  // Impacto visual al caer AMBOS en la misma casilla: onda expansiva one-shot
  // + pop de aterrizaje de las fichas (el próximo renderBoard() limpia todo).
  if(willClash){
    const cell = document.querySelector('.cell.is-both-here');
    if(cell){
      cell.classList.add('is-impact');
      const fx = document.createElement('div'); fx.className='clash-fx';
      cell.appendChild(fx);
    }
    shakeBoard();
    haptic([12,30,12]);
  }
  // Aviso de duelo: cayeron en casillas contiguas (misma condición que dispara
  // el duelo más abajo). Una onda grande centrada en el punto medio entre
  // ambos, misma estética que clash-fx (el próximo renderBoard limpia todo).
  const willDuel = !willClash && !wasTruce &&
    areAdjacentOrSame(G.you, G.opp) && !wallSeparates(G.you, G.opp);
  if(willDuel){
    const boardEl = $('board');
    const cellYou = document.querySelector(`.cell[data-x="${G.you.x}"][data-y="${G.you.y}"]`);
    const cellOpp = document.querySelector(`.cell[data-x="${G.opp.x}"][data-y="${G.opp.y}"]`);
    if(cellYou && cellOpp){
      // Punto medio en píxeles relativo al board (los rects ya reflejan la
      // vista espejada del guest y el tamaño real de celda/gap)
      const br = boardEl.getBoundingClientRect();
      const ry = cellYou.getBoundingClientRect(), ro = cellOpp.getBoundingClientRect();
      const cx = (ry.left + ry.width/2 + ro.left + ro.width/2)/2 - br.left;
      const cy = (ry.top + ry.height/2 + ro.top + ro.height/2)/2 - br.top;
      const size = ry.width * 2.2;   // aurora grande: cubre las dos casillas
      // Esperar a que TERMINE el deslizamiento FLIP de las fichas
      // (~2 frames + .35s de transición, ver flipMarker) antes de la onda.
      setTimeout(()=>{
        const fx = document.createElement('div'); fx.className='duel-fx';
        fx.style.left = cx+'px'; fx.style.top = cy+'px';
        fx.style.width = size+'px'; fx.style.height = size+'px';
        boardEl.appendChild(fx);
        haptic([12,30,12]);
      }, 400);
    }
  }
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
    // Ambos cayeron en la MISMA casilla con un ítem: se lo disputan a piedra-
    // papel-tijera (empate → ruleta), y recién después sigue el flujo normal
    // (duelo si no había tregua; nada más si la había).
    if(sharedBuff){ startBuffContest(sharedBuff, proceed); }
    else proceed();
  // Con aviso de duelo, dar tiempo a que la onda (arranca a los 400ms, dura
  // .7s) se vea completa antes del countdown. Determinista: ambos clientes
  // calculan el mismo willDuel, así que online quedan sincronizados igual.
  }, willDuel ? 1150 : 550);
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
    // La partida pudo terminar en el medio (abandono del rival): cortar la cadena
    // de timeouts acá — sin esto la ruleta seguía girando sobre la pantalla de
    // victoria y el done() final relanzaba la fase de juego post-gameover.
    if(!G.running){ ov.style.display='none'; return; }
    if(i>=delays.length){
      const win = info.youWins ? nYou : nOpp;
      const lose = info.youWins ? nOpp : nYou;
      lose.classList.remove('is-on');
      win.classList.add('is-winner');
      haptic(12);
      setTimeout(()=>{ ov.style.display='none'; if(G.running) done(); }, 450);
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

// ===== 🪨📄✂️ Piedra-papel-tijera por el buff compartido =====
// Ambos cayeron en la misma casilla con un ítem: cada uno elige piedra/papel/
// tijera (0/1/2). Picks distintos → gana el clásico; empate → la ruleta de
// siempre, con ganador rol-absoluto (mismo resultado en las dos pantallas).
// Online copia el modelo del duelo: cada cliente sube SOLO su pick a
// game/rps/{rN}/{rol} y ambos resuelven idéntico cuando están los dos.
const RPS_EMOJI = ['🪨','📄','✂️','⏰'];
const RPS_NO_PICK = 3;         // sentinel "no eligió" (viaja como un pick más; reglas validan 0-3)
const RPS_TIMEOUT_MS = 6000;   // online: plazo para elegir — vencido quedás sin elección (feel, no CFG)

// Barra de tiempo del RPS (solo online, v0.3.40): misma receta visual que la
// barra de inactividad (llena→0 con transition width linear, verde→amarillo→
// rojo; reusa las clases .idle-timer). Timers en G.rps.timers → mueren solos
// con hideRpsOverlay.
function showRpsTimerBar(){
  const bar=$('rps-timer'), fill=$('rps-timer-fill');
  if(!bar || !fill || !G.rps) return;
  fill.className='idle-timer__fill is-green';
  fill.style.transition='none';
  fill.style.width='100%';
  bar.classList.add('is-show');
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      if(!G.rps) return;
      fill.style.transition=`width ${RPS_TIMEOUT_MS}ms linear`;
      fill.style.width='0%';
    });
  });
  G.rps.timers.push(setTimeout(()=>{
    fill.classList.remove('is-green'); fill.classList.add('is-yellow');
  }, Math.round(RPS_TIMEOUT_MS*0.5)));
  G.rps.timers.push(setTimeout(()=>{
    fill.classList.remove('is-yellow'); fill.classList.add('is-red');
    bar.classList.add('is-danger');
  }, RPS_TIMEOUT_MS-1500));
}

function hideRpsTimerBar(){
  const bar=$('rps-timer'), fill=$('rps-timer-fill');
  if(!bar || !fill) return;
  bar.classList.remove('is-show','is-danger');
  fill.style.transition='none';
  fill.style.width='100%';
  fill.className='idle-timer__fill is-green';
}

function startBuffContest(info, done){
  const ov=$('rps-overlay');
  if(!ov){
    // Defensivo (sin overlay): otorgar directo por el sorteo sincronizado y seguir
    const youWins = (myAbsRole()==='host') ? info.hostWins : !info.hostWins;
    G.rps={ info };
    grantContestedItem(youWins);
    G.rps=null;
    done(); return;
  }
  G.rps = { info, done, myPick:null, oppPick:null, resolved:false, timers:[] };
  $('rps-item').textContent=info.itemEmoji;
  $('rps-caption').textContent=TEXTS.rpsCaption;
  $('rps-status').textContent='';
  $('rps-reveal').hidden=true;
  $('rps-choices').style.display='flex';
  ov.querySelectorAll('.rps-btn').forEach(b=>{ b.disabled=false; b.classList.remove('is-picked','is-dimmed'); });
  hideRpsTimerBar();   // reset: la barra solo se muestra online
  ov.style.display='flex';
  if(G.online){
    Net.onRpsPicks = onRpsPicksReady;
    Net.onOppRpsPicked = ()=>{
      if(G.rps && !G.rps.resolved && G.rps.myPick==null) $('rps-status').textContent=TEXTS.rpsOppReady;
    };
    Net.listenRpsPicks('r'+info.turn);
    // v0.3.40: no elegir ya NO auto-elige al azar — quedás "sin elección" (3)
    // y el que sí eligió se lleva el ítem. La barra hace visible el plazo.
    showRpsTimerBar();
    G.rps.timers.push(setTimeout(()=>{
      if(!G.running || !G.rps || G.rps.resolved || G.rps.myPick!=null) return;
      rpsNoPickLocal();
    }, RPS_TIMEOUT_MS));
    // Reloj global: si el pick del rival tampoco llegó (pestaña de fondo → sus
    // timers frenados), su "no elección" la escribo yo. First-write-wins: una
    // elección real que llegue antes gana y esta transaction aborta sola.
    G.rps.timers.push(setTimeout(()=>{
      if(!G.running || !G.rps || G.rps.resolved) return;
      Net.pushOppRpsFallback('r'+G.rps.info.turn).catch(e=>console.error('[rps] fallback', e));
    }, RPS_TIMEOUT_MS + NET_RPS_GRACE_MS));
  } else {
    // CPU: elige al azar tras una pausa corta (random local: no hay otro cliente)
    G.rps.timers.push(setTimeout(()=>{
      if(!G.running || !G.rps || G.rps.resolved) return;
      G.rps.oppPick = Math.floor(Math.random()*3);
      maybeResolveRpsOffline();
    }, 400+Math.random()*500));
  }
}

function rpsPickLocal(pick){
  if(!G.rps || G.rps.resolved || G.rps.myPick!=null) return;
  G.rps.myPick = pick;
  document.querySelectorAll('#rps-choices .rps-btn').forEach(b=>{
    b.disabled=true;
    b.classList.toggle('is-picked', +b.dataset.pick===pick);
    b.classList.toggle('is-dimmed', +b.dataset.pick!==pick);
  });
  Sound.step && Sound.step(); haptic(10);
  if(G.online){
    $('rps-status').textContent=TEXTS.rpsWaitingOpp;
    // La resolución SIEMPRE llega por el listener con ambos picks (nunca desde
    // el push propio) — misma disciplina que commitMyDuelScore.
    Net.pushRpsPick('r'+G.rps.info.turn, pick).catch(e=>console.error('[rps] push', e));
  } else {
    maybeResolveRpsOffline();
  }
}

function maybeResolveRpsOffline(){
  if(!G.rps || G.rps.resolved) return;
  if(G.rps.myPick!=null && G.rps.oppPick!=null) resolveRps(G.rps.myPick, G.rps.oppPick);
}

// Venció mi plazo sin elegir (solo online): quedo "sin elección" — el sentinel
// 3 viaja igual que un pick real y pierde contra cualquier elección del rival.
function rpsNoPickLocal(){
  if(!G.rps || G.rps.resolved || G.rps.myPick!=null) return;
  G.rps.myPick = RPS_NO_PICK;
  document.querySelectorAll('#rps-choices .rps-btn').forEach(b=>{ b.disabled=true; b.classList.add('is-dimmed'); });
  $('rps-status').textContent = TEXTS.rpsNoPickYou;
  Net.pushRpsPick('r'+G.rps.info.turn, RPS_NO_PICK).catch(e=>console.error('[rps] push', e));
}

// Online: llegaron ambos picks desde Firebase. Mapear por rol (espejo de
// onDuelScoresReady) y resolver — cada cliente compara desde su perspectiva,
// la comparación es simétrica, así que ambos coinciden en el único ganador.
function onRpsPicksReady(picks){
  if(!G.rps) return;
  const mine  = (Net.role==='host') ? picks.host  : picks.guest;
  const other = (Net.role==='host') ? picks.guest : picks.host;
  if(G.rps.myPick==null) G.rps.myPick = mine;   // por si mi push rebotó antes que el timeout local
  resolveRps(mine, other);
}

function resolveRps(myPick, oppPick){
  if(!G.rps || G.rps.resolved || !G.running) return;
  G.rps.resolved = true;
  G.rps.timers.forEach(clearTimeout); G.rps.timers=[];
  hideRpsTimerBar();
  // Revelado: fuera los botones, ambos picks a la vista (textContent siempre —
  // el nick del rival es input remoto, lección XSS v0.3.27).
  $('rps-choices').style.display='none';
  $('rps-status').textContent='';
  const chipYou=$('rps-chip-you'), chipOpp=$('rps-chip-opp');
  chipYou.textContent = App.playerName+' '+RPS_EMOJI[myPick];
  chipOpp.textContent = RPS_EMOJI[oppPick]+' '+App.oppName;
  chipYou.classList.remove('is-winner'); chipOpp.classList.remove('is-winner');
  $('rps-reveal').hidden=false;
  Sound.step && Sound.step(); haptic(8);
  const tie = (myPick===oppPick);
  G.rps.timers.push(setTimeout(()=>{
    if(!G.running || !G.rps) return;
    if(tie){
      // Empate: beat corto y cae a la ruleta de siempre, ya sincronizada
      $('rps-caption').textContent=TEXTS.rpsTieLine;
      G.rps.timers.push(setTimeout(()=>{
        if(!G.running || !G.rps) return;
        const st=G.rps;
        const youWins = (myAbsRole()==='host') ? st.info.hostWins : !st.info.hostWins;
        grantContestedItem(youWins);   // contrato de showBuffRoulette: sorteo ya aplicado
        hideRpsOverlay();
        showBuffRoulette({ youWins, itemEmoji: st.info.itemEmoji }, st.done);
      }, 900));
      return;
    }
    // beats: (a-b+3)%3===1 → papel>piedra, tijera>papel, piedra>tijera.
    // "Sin elección" (3) pierde contra cualquier pick real; 3 vs 3 ya cayó
    // arriba como empate → ruleta (el ítem no se pierde nunca).
    const youWin = (oppPick===RPS_NO_PICK) ? true
                 : (myPick===RPS_NO_PICK)  ? false
                 : ((myPick - oppPick + 3) % 3) === 1;
    (youWin ? chipYou : chipOpp).classList.add('is-winner');
    $('rps-caption').textContent = fillText('rpsWinnerLine', { name: youWin?App.playerName:App.oppName });
    grantContestedItem(youWin);
    Sound.seq([[youWin?740:392,0.08,0.05,'triangle',0],[youWin?988:294,0.11,0.05,'triangle',90]]);
    haptic(12);
    G.rps.timers.push(setTimeout(()=>{
      const st=G.rps; if(!st) return;
      hideRpsOverlay();
      if(G.running) st.done();
    }, 1400));
  }, 1200));
}

// Otorga el ítem disputado al ganador: restaura la casilla y reusa
// applyCellEffect tal cual (única fuente de la lógica ring/cofre/botas —
// re-vacía la casilla y dispara los toasts/sonidos de siempre). Un cofre con
// teleport reubica al ganador acá; proceed() recalcula la adyacencia del duelo
// con las posiciones vivas, idéntico en ambos clientes (todo determinista).
function grantContestedItem(youWins){
  const info = G.rps && G.rps.info;
  if(!info) return;
  const winner = youWins ? G.you : G.opp;
  const cell = cellAt(info.x, info.y);
  cell.type = info.cellType;
  applyCellEffect(winner);
  renderBoard(); updateHud();
}

// Cierre en seco del contest (abandono del rival, salida propia, sala caída):
// overlays ocultos, timers muertos, listener suelto. El done() pendiente NO se
// llama — quien cierra la partida ya decidió qué pantalla sigue.
function hideRpsOverlay(){
  const ov=$('rps-overlay'); if(ov) ov.style.display='none';
  const ro=$('roulette-overlay'); if(ro) ro.style.display='none';
  hideRpsTimerBar();
  if(G.rps){ G.rps.timers.forEach(clearTimeout); G.rps=null; }
  if(Net.stopRpsListen) Net.stopRpsListen();
}
// Rol absoluto para decisiones compartidas: online cada cliente mira su Net.role;
// offline no hay roles y el jugador local ocupa la perspectiva del host. Clave para
// que un mismo dato determinista (ej. hostWins) se traduzca a you/opp sin desync.
function myAbsRole(){ return (G.online && Net.role) ? Net.role : 'host'; }

// Aplica los efectos de casilla de ambos jugadores. Si los dos caen en la MISMA
// casilla con un buff, el ítem se DISPUTA a piedra-papel-tijera (startBuffContest);
// acá solo se describe la disputa — la casilla se consume ya (así el render inmediato
// la pinta vacía en ambos clientes) y el ganador la recibe en grantContestedItem.
// hostWins (fallback de empate) va en rol ABSOLUTO: el viejo sorteo mapeaba el seed
// a G.you/G.opp, que son relativos a cada pantalla — online ambos se veían ganar.
function applySharedCellEffects(){
  const sameCell = (G.you.x===G.opp.x && G.you.y===G.opp.y);
  if(sameCell){
    const cell = cellAt(G.you.x, G.you.y);
    if(cell.type==='power_dmg' || cell.type==='power_def' || cell.type==='ring' || cell.type==='chest' || cell.type==='boots'){
      // Sorteo determinista: depende del turno y la posición (igual en ambos clientes)
      const seed = (G.turnCount*31 + G.you.x*7 + G.you.y*13) % 2;
      const info = {
        cellType: cell.type, x: G.you.x, y: G.you.y,
        turn: G.turnCount,          // PRE-incremento (resolveMoves lo sube después)
        hostWins: (seed===0),
        itemEmoji: { power_dmg:'🗡️', power_def:'◈', chest:'🎁', boots:'👟', ring:'💍' }[cell.type],
      };
      cell.type='empty';            // grantContestedItem la restaura al otorgar
      return info;
    }
    if(cell.type==='down'){
      // Trampa compartida: ambos la pisan (ambos reciben el daño)
      applyCellEffect(G.you);
      // la casilla ya se consumió; aplicar daño al otro manualmente
      G.opp.hp = Math.max(1, G.opp.hp - CFG.downDamage);
      return null;
    }
    if(cell.type==='bomb'){
      // Bomba compartida: se arma UNA vez (ambos están parados encima)
      applyCellEffect(G.you);
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
      player.hp = Math.min(player.maxHp || CFG.maxHp, player.hp + CFG.ringBigHeal);
      const who = (player===G.you)?App.playerName:App.oppName;
      toast(fillText('toastRingBig', {who, heal:CFG.ringBigHeal}));
    } else {
      // Cura goteo: 5 HP por ronda durante 5 rondas (incluida esta)
      player.ringDrip = CFG.ringDripRounds;
      const who = (player===G.you)?App.playerName:App.oppName;
      toast(fillText('toastRingDrip', {who, heal:CFG.ringDripHeal, rounds:CFG.ringDripRounds}));
    }
  }
  else if(cell.type==='chest'){
    cell.type='empty';
    applyChestEffect(player);
  }
  else if(cell.type==='boots'){
    cell.type='empty';
    player.boots = true;   // el PRÓXIMO movimiento puede ser a radio 2 (un pick)
    Sound.pickupDef && Sound.pickupDef();
    toast(fillText('bootsPicked', {name:(player===G.you)?App.playerName:App.oppName}));
  }
  else if(cell.type==='bomb'){
    // Pisarla la ARMA: explota CFG.bombFuse resoluciones después (detonateBombs).
    // armedTurn usa el turnCount PRE-incremento (applyCellEffect corre antes
    // del turnCount++ de resolveMoves) — igual en ambos clientes.
    cell.type='bomb_armed';
    if(!G.bombs) G.bombs=[];
    G.bombs.push({ x: player.x, y: player.y, armedTurn: G.turnCount });
    Sound.trap && Sound.trap();
    toast(TEXTS.bombArmed);
  }
}

// ---- 💣 Modo Caos: bombas ----
// Casillas afectadas por la explosión: cruz (5) o 3x3 (9) según CFG.bombArea.
function bombArea(bx, by){
  const cells = [{x:bx, y:by}];
  const deltas = CFG.bombArea
    ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
    : [[0,-1],[-1,0],[1,0],[0,1]];
  const n = CFG.boardSize;
  deltas.forEach(([dx,dy])=>{
    const x=bx+dx, y=by+dy;
    if(x>=0 && y>=0 && x<n && y<n) cells.push({x,y});
  });
  return cells;
}

// Detona las bombas cuya mecha venció (turnCount PRE-incremento, ver el
// armado). Corre en resolveMoves ANTES del render: determinista, ambos
// clientes computan lo mismo. Piedad como las trampas: nunca mata (floor 1).
// Devuelve las casillas afectadas (para el fx post-render) o null.
function detonateBombs(){
  if(!G.bombs || !G.bombs.length) return null;
  const due = G.bombs.filter(b => G.turnCount - b.armedTurn >= CFG.bombFuse);
  if(!due.length) return null;
  G.bombs = G.bombs.filter(b => G.turnCount - b.armedTurn < CFG.bombFuse);
  const hitCells = [];
  let someoneHit = false;
  due.forEach(b=>{
    cellAt(b.x, b.y).type = 'empty';
    bombArea(b.x, b.y).forEach(c=>{
      hitCells.push(c);
      [G.you, G.opp].forEach(pl=>{
        if(pl.x===c.x && pl.y===c.y){ pl.hp = Math.max(1, pl.hp - CFG.bombDamage); someoneHit = true; }
      });
    });
  });
  Sound.trap && Sound.trap();
  haptic(someoneHit ? [20,50,20] : [12,25,12]);
  toast(TEXTS.bombExploded);
  return hitCells;
}

// ---- 🌀 Modo Caos: helpers de portal y cofre ----
// Devuelve el portal GEMELO de la casilla (x,y), o null si (x,y) no es portal.
// Los portales van siempre de a dos (garantizado en buildBoard).
function portalTwin(x, y){
  if(cellAt(x,y).type !== 'portal') return null;
  const twin = G.board.find(c => c.type==='portal' && !(c.x===x && c.y===y));
  return twin ? { x: twin.x, y: twin.y } : null;
}

// Cofre sorpresa: efecto aleatorio DETERMINISTA — mismo turno y posición dan
// el mismo resultado en ambos clientes (cero Math.random, como el sorteo de
// ítems compartidos). El teleport marca G._teleYou/_teleOpp para que
// resolveMoves no anime con FLIP a quien viajó.
function applyChestEffect(player){
  const roll = (G.turnCount*31 + player.x*7 + player.y*13) % 5;
  const who = (player===G.you) ? App.playerName : App.oppName;
  if(roll===0){
    player.buffs.dmg += CFG.powerDmgValue; Sound.pickupAtk();
    toast(fillText('chestGotAtk', {name:who}));
  } else if(roll===1){
    player.buffs.def += CFG.powerDefValue; Sound.pickupDef();
    toast(fillText('chestGotDef', {name:who}));
  } else if(roll===2){
    player.hp = Math.min(player.maxHp || CFG.maxHp, player.hp + CFG.chestHeal);
    Sound.pickupDef();
    toast(fillText('chestGotHeal', {name:who, hp:CFG.chestHeal}));
  } else if(roll===3){
    // Trampa: mismo daño y misma piedad que las cruces (nunca mata)
    player.hp = Math.max(1, player.hp - CFG.downDamage);
    Sound.trap();
    toast(fillText('chestTrap', {name:who}));
  } else {
    // Teleport a una casilla vacía elegida determinísticamente
    const n = CFG.boardSize;
    const idx = (G.turnCount*17 + player.x*5 + player.y*11) % (n*n);
    const spot = findEmptySpotFrom(idx);
    if(spot){
      player.x = spot.x; player.y = spot.y;
      if(player===G.you) G._teleYou = true; else G._teleOpp = true;
    }
    Sound.pickupDef && Sound.pickupDef();
    toast(fillText('chestTeleport', {name:who}));
  }
}

// Primera casilla VACÍA y desocupada desde un índice dado, escaneo circular
// (determinista: mismo board + mismo índice = misma casilla en ambos clientes).
function findEmptySpotFrom(idx){
  const total = CFG.boardSize * CFG.boardSize;
  for(let i=0; i<total; i++){
    const c = G.board[(idx + i) % total];
    const occupied = (G.you.x===c.x && G.you.y===c.y) || (G.opp.x===c.x && G.opp.y===c.y);
    if(c.type==='empty' && !occupied) return { x: c.x, y: c.y };
  }
  return null;
}

// Aplica el goteo de curación del anillo (llamado cada ronda/turno)
function applyRingDrip(player){
  if(player.ringDrip && player.ringDrip>0){
    player.hp = Math.min(player.maxHp || CFG.maxHp, player.hp + CFG.ringDripHeal);
    player.ringDrip--;
  }
}

// Calcula (sin aplicar) las posiciones post-empate, en la perspectiva del que
// llama. El azar es del calculador: online lo corre UN solo cliente y el
// resultado viaja por Firebase como valor canónico para ambos.
function computeEjectPositions(){
  const ejectFrom = (start, other)=>{
    const pos = { x:start.x, y:start.y };
    const dist = CFG.ejectMinDist + Math.floor(Math.random()*(CFG.ejectMaxDist-CFG.ejectMinDist+1));
    let vx = start.x-other.x, vy = start.y-other.y;
    if(vx===0&&vy===0){ vx=1; vy=0; }
    for(let i=0;i<dist;i++){
      const reachable = getReachable(pos.x, pos.y);
      if(reachable.length===0) break;
      const scored = reachable.map(p=>{
        const newDist = Math.sqrt(Math.pow(p.x-other.x,2)+Math.pow(p.y-other.y,2));
        const dx=p.x-pos.x, dy=p.y-pos.y;
        const alignment = (dx*vx+dy*vy)/(Math.sqrt(dx*dx+dy*dy)*Math.sqrt(vx*vx+vy*vy)+0.01);
        let score = newDist + alignment*2;
        if(areAdjacentOrSame(p,other)) score-=10;
        score += Math.random()*1.5; return {...p, score};
      });
      scored.sort((a,b)=>b.score-a.score); pos.x=scored[0].x; pos.y=scored[0].y;
    }
    return pos;
  };
  const you = ejectFrom(G.you, G.opp);
  const opp = ejectFrom(G.opp, you);   // el segundo esquiva la posición NUEVA del primero
  if(areAdjacentOrSame(you, opp)){
    const alt = getReachable(you.x, you.y).find(p => !areAdjacentOrSame(p, opp));
    if(alt){ you.x=alt.x; you.y=alt.y; }
  }
  return { you, opp };
}

// Offline: calcular y aplicar directo (un solo cliente, sin sincronizar).
function ejectPlayers(){
  const pos = computeEjectPositions();
  G.you.x=pos.you.x; G.you.y=pos.you.y; G.opp.x=pos.opp.x; G.opp.y=pos.opp.y;
  Sound.eject(); haptic([15,30,15,30,15]);
}

// Online: ambos clientes aplican las posiciones CANÓNICAS del nodo eject de
// Firebase (siempre en perspectiva del host; el guest cruza). El host ya no
// aplica su cálculo local directo: pudo perder la carrera contra el fallback
// del guest (reloj global v0.3.40) y el valor que vale es el que quedó escrito.
function applyEjectPositions(e){
  if(!G.running) return;
  if(myAbsRole()==='host'){
    G.you.x=e.youPos.x; G.you.y=e.youPos.y; G.opp.x=e.oppPos.x; G.opp.y=e.oppPos.y;
  } else {
    G.you.x=e.oppPos.x; G.you.y=e.oppPos.y; G.opp.x=e.youPos.x; G.opp.y=e.youPos.y;
  }
  Sound.eject(); haptic([15,30,15,30,15]);
  renderBoard(); updateHud(); startChoosePhase();
}

// Muestra/oculta el overlay de duelo. Además pausa las animaciones CSS
// decorativas del tablero (portal girando, bomba latiendo, anillo, marco de
// choque) vía body.is-dueling: el overlay es SEMITRANSPARENTE (--overlay 0.96)
// así que el board se sigue pintando abajo, y esos loops infinitos compiten
// con el rAF de la aguja — en móvil se veía "lageada" (misma familia que el
// fix v0.2.95 de layout-thrashing; regresión reportada al salir Modo Caos).
function setDuelOverlayShown(on){
  $('duel-overlay').classList.toggle('is-show', on);
  document.body.classList.toggle('is-dueling', on);
  // Al abrir: cortar EN SECO el feedback de daño del HUD si quedó a mitad de
  // camino (daño por trampa/bomba justo antes del duelo). La transición de
  // width de la ghost bar hace layout por frame aunque el HUD esté oculto
  // detrás del overlay, y eso compite con el rAF de la aguja en móvil.
  if(on){
    ['you','opp'].forEach(side=>{
      const g=$('hp-ghost-'+side);
      if(g){ g.style.transition='none'; g.style.width='0'; g.style.opacity='0'; }
      const n=$('hp-num-'+side);
      if(n){
        n.classList.remove('is-hit');
        if(n._twnRaf){ cancelAnimationFrame(n._twnRaf); n._twnRaf=null; }
        if(G[side]) n.textContent=Math.max(0, G[side].hp);
      }
    });
  }
}

// DOM/estado compartido por el countdown del duelo, offline y online.
function showDuelCountdownUI(){
  setDuelOverlayShown(true);
  $('duel-result').style.display='none';
  $('duel-game').style.display='none';
  $('duel-countdown').style.display='block';
  $('duel-title').textContent=TEXTS.duelTitleEncounter;
  Sound.duelStart(); setMsg(TEXTS.msgDuelImminent);
  const btn = $('duel-stop');
  btn.classList.remove('is-active','is-pressed');
  btn.classList.add('is-visible');
  btn.disabled = true;
}

// Corre "3, 2, 1, ¡YA!" y llama onDone() al terminar (offline y online usan el mismo timing).
function runDuelCountdown(onDone){
  const steps=[3,2,1,TEXTS.duelCountdownGo]; let i=0; const cd=$('duel-countdown');
  const tick=()=>{
    if(G.phase!=='duel-countdown') return;   // se salió/terminó: abortar
    if(i>=steps.length){ onDone(); return; }
    cd.textContent=steps[i]; cd.classList.add('is-pop');
    Sound.countdown(); haptic(12);
    setTimeout(()=>cd.classList.remove('is-pop'),200);
    i++; setTimeout(tick, CFG.duelCountdownMs);
  };
  tick();
}

function startDuel(){
  G.phase='duel-countdown';
  showDuelCountdownUI();
  runDuelCountdown(beginDuelPlay);
}

// Reseteo de estado compartido por offline/online al arrancar el minijuego de reflejos.
function resetDuelPlayState(){
  // Un cpuTimer viejo (duelo offline anterior) no debe frenar por el rival
  // de ESTE duelo — se limpia acá (camino compartido), no solo en offline.
  if(G.duel.cpuTimer){ clearTimeout(G.duel.cpuTimer); G.duel.cpuTimer=null; }
  $('duel-countdown').style.display='none';
  $('duel-game').style.display='flex';
  hideDuelReveal(); G._revealShown=false; G._duelResolved=false;
  $('duel-title').textContent=TEXTS.duelTitleStopGreen;
  buildSpeedometer();
  G.duel.time=0;
  G.duel.pass=1;
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
}

// Arranca el rAF loop del duelo; updateFn hace avanzar tiempo/pases (distinto offline/online).
function startDuelRaf(updateFn){
  const loop=(ts)=>{
    if(G.phase!=='duel-play') return;
    const dt=Math.min(0.05,(ts-G.duel.lastTs)/1000);
    G.duel.lastTs=ts;
    updateFn(dt);
    renderIndicator();
    G.duel.raf=requestAnimationFrame(loop);
  };
  G.duel.raf=requestAnimationFrame(loop);
}

function beginDuelPlay(){
  G.phase='duel-play';
  resetDuelPlayState();   // también limpia un cpuTimer pendiente
  G.duel.stopped=false;
  startDuelRaf(updateIndicator);
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
    el.textContent=TEXTS.duelLastPassLabel;
    el.classList.add('is-danger');
    el.classList.remove('is-warn');
  } else if(G.duel.pass>=3){
    el.textContent=fillText('duelPassLabel', {pass:G.duel.pass, max:CFG.duelMaxPasses});
    el.classList.add('is-warn');
    el.classList.remove('is-danger');
  } else {
    el.textContent=fillText('duelPassLabel', {pass:G.duel.pass, max:CFG.duelMaxPasses});
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
  const desperate  = G.opp.hp <= cpuDesperateHp();
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

  let yourDmg = duelDamage(rawYou, youPerfect, youDmgEff, oppDefEff);
  let oppDmg  = duelDamage(rawOpp, oppPerfect, oppDmgEff, youDefEff, cpuDmgMult());
  // ⛰️ Modo Caos: duelar parado en terreno alto suma un bonus chico al daño
  // propio. Va DESPUÉS de duelDamage: no cambia quién gana el duelo (eso es
  // solo el score crudo), no lo anula el perfecto rival, y solo aplica si el
  // golpe conecta (daño > 0).
  if(App.chaosMode){
    if(yourDmg > 0 && cellAt(G.you.x, G.you.y).type==='high') yourDmg += CFG.highBonus;
    if(oppDmg  > 0 && cellAt(G.opp.x, G.opp.y).type==='high') oppDmg  += CFG.highBonus;
  }
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
  if(isPerfect(pos, pass))                                   return { name:TEXTS.zoneNamePerfect, color:'var(--perfect)', perfect:true };
  if(pos >= CFG.duelGreenStart && pos <= CFG.duelGreenEnd)   return { name:TEXTS.zoneNameGreen,   color:'var(--good)' };
  if(pos >= CFG.duelYellowStart && pos <= CFG.duelYellowEnd) return { name:TEXTS.zoneNameYellow,color:'var(--warn)' };
  if(pos >= CFG.duelOrangeStart && pos <= CFG.duelOrangeEnd) return { name:TEXTS.zoneNameOrange, color:'var(--orange)' };
  if(pos >= CFG.duelOrange2Start && pos <= CFG.duelOrange2End) return { name:TEXTS.zoneNameOrange, color:'var(--orange)' };
  return { name:TEXTS.zoneNameRed, color:'var(--bad)' };
}

// Frenaste en PERFECTO: feedback inmediato al soltar la aguja — SOLO sting
// agudo + haptic ascendente (costo visual cero: la aguja del rival puede
// seguir barriendo y cualquier animación/reflow acá compite con su rAF en
// móvil — v0.3.32 tenía un pop del botón y se quitó por eso). El premio
// visual grande llega igual en el reveal, 1-2s después.
function perfectStopFx(){
  Sound.perfect && Sound.perfect();
  haptic([10,20,35]);
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
  if(G.duel.yourScore===CFG.perfectScore) perfectStopFx();
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
  if(on){ popClass(el,'is-perfect-hit'); }
  else { el.classList.remove('is-perfect-hit'); }
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
  // Limpiar el resplandor del duelo anterior; si hubo súper golpe, el flash
  // dorado entra con un micro-beat (más abajo, ya con el panel visible).
  flashPerfectHit(bYou, false);
  flashPerfectHit(bOpp, false);

  // Quién gana el duelo lo decide SOLO el puntaje crudo del minijuego (0-20),
  // nunca los buffs: eso mantiene el minijuego totalmente independiente.
  // Verdict corto: "GANA {nombre}" con el GANA en verde si ganaste vos y en
  // rojo si ganó el rival. Debajo, los puntajes chicos en gris: "(6v3)".
  // Los nombres van ESCAPADOS: esto es innerHTML y online el nombre del rival
  // viene de otro cliente (sin escape, un nickname con HTML se inyectaba acá).
  const vEl=$('reveal-verdict');
  if(rawYou>rawOpp){
    const sup = youPerfect ? TEXTS.duelPerfectPrefix : '';
    vEl.innerHTML=fillText('duelVerdictWin', { perfectPrefix:sup, name:escHtml(App.playerName) });
  } else if(rawOpp>rawYou){
    const sup = oppPerfect ? TEXTS.duelPerfectPrefix : '';
    vEl.innerHTML=fillText('duelVerdictLose', { perfectPrefix:sup, name:escHtml(App.oppName) });
  } else {
    vEl.innerHTML=TEXTS.duelVerdictTie;
  }
  const sEl=$('reveal-scoreline');
  if(sEl) sEl.textContent=`(${rawYou}v${rawOpp})`;

  // El velocímetro (duel-game) sigue visible; solo añadimos el panel arriba.
  $('duel-stop').classList.remove('is-active');
  $('duel-reveal').style.display='flex';
  // Micro-beat del súper golpe: el panel aparece, respira 110ms y RECIÉN ahí
  // golpea el dorado + sting (el "hit-stop" percibido, sin pausar el rAF).
  if(youPerfect || oppPerfect){
    setTimeout(()=>{
      if(youPerfect) flashPerfectHit(bYou, true);
      if(oppPerfect) flashPerfectHit(bOpp, true);
      Sound.perfect && Sound.perfect();
      haptic([15,30,15]);
    }, 110);
  }
  $('duel-title').textContent=TEXTS.duelResultTitle;
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
    titleEl.textContent=TEXTS.duelTieTitle; titleEl.classList.add('is-tie');
    sub.textContent=TEXTS.duelTieSub;
  } else {
    const winName = o.youWin ? App.playerName : App.oppName;
    titleEl.textContent = o.youWin ? TEXTS.duelWinTitle : TEXTS.duelLoseTitle;
    titleEl.classList.add(o.youWin ? 'is-win' : 'is-lose');
    sub.textContent = o.perfect ? fillText('duelPerfectSub', {name:winName}) : '';
  }
  $('rescol-name-you').textContent=App.playerName;
  $('rescol-name-opp').textContent=App.oppName;
  const reduceMotion = prefersReduced();
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
    const setColor=(p)=>setHpBarColor(fill, p);
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
      tweenNum(numEl, Math.max(0,before), Math.max(0,after), 900);
    }, 500);
  };
  col('you', o.youBefore, G.you.hp, G.you.maxHp || CFG.maxHp);
  col('opp', o.oppBefore, G.opp.hp, G.opp.maxHp || CFG.maxHp);
}

// Aplica el resultado del duelo (según puntaje crudo, no el daño ya modificado
// por buffs) a la vida de ambos, muestra showDuelOutcome()+sonido, y devuelve
// los números para que el caller (offline/online) haga su propio post-proceso
// (stats, sync de eject, espectador, etc — eso SÍ difiere entre los dos).
function applyDuelOutcome(){
  const rawYou=G.duel.yourScore??0, rawOpp=G.duel.oppScore??0;
  const dmg=computeDuelDamages();
  const yourRealDmg=dmg.yourDmg, oppRealDmg=dmg.oppDmg;
  const youHpBefore=G.you.hp, oppHpBefore=G.opp.hp;
  let isTie=false, youWin=false, chip=0;
  if(rawYou>rawOpp){
    youWin=true;
    const rawChip=loserChipDamage(oppRealDmg, yourRealDmg);
    chip=chipWithMercy(G.you.hp, rawChip);   // tiro de gracia: ganar no te mata
    G.opp.hp=Math.max(0,G.opp.hp-yourRealDmg);
    G.you.hp=Math.max(0,G.you.hp-chip);
    showDuelOutcome({ youWin:true, perfect:dmg.youPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.win(); haptic([15,30,15]);
  } else if(rawOpp>rawYou){
    const rawChip=loserChipDamage(yourRealDmg, oppRealDmg);
    chip=chipWithMercy(G.opp.hp, rawChip);   // tiro de gracia: el rival ganador no muere por chip
    G.you.hp=Math.max(0,G.you.hp-oppRealDmg);
    G.opp.hp=Math.max(0,G.opp.hp-chip);
    showDuelOutcome({ youWin:false, perfect:dmg.oppPerfect, youBefore:youHpBefore, oppBefore:oppHpBefore });
    Sound.lose(); haptic([20,60,20]);
  } else {
    isTie=true; showDuelOutcome({ tie:true, youBefore:youHpBefore, oppBefore:oppHpBefore }); Sound.tie();
  }
  return { isTie, youWin, rawYou, rawOpp, yourRealDmg, oppRealDmg, chip };
}

function resolveDuel(){
  if(G._duelResolved) return;        // ya resuelto: ignorar llamadas repetidas
  if(!G.running) return;             // la partida murió en el medio (salida/abandono)
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
  const { isTie } = applyDuelOutcome();
  G.you.buffs={dmg:0,def:0}; G.opp.buffs={dmg:0,def:0};
  G.justDueled = true;
  hideDuelReveal();
  $('duel-stop').classList.remove('is-visible','is-active','is-pressed');
  $('duel-result').style.display='flex'; $('duel-game').style.display='none';
  updateHud();
  setTimeout(()=>{
    setDuelOverlayShown(false);
    if(!G.running) return;   // se salió de la partida durante el resultado
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
  showDuelCountdownUI();

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

  runDuelCountdown(beginDuelPlayOnline);
}

function beginDuelPlayOnline(){
  G.phase='duel-play';
  resetDuelPlayState();
  // G.duel.oppScore/oppStopped: en online los llena Firebase, no acá.
  // Reloj global: si el rival tiene la pestaña de fondo, su rAF está congelado
  // y nunca comete NI SIQUIERA el score 0 del timeout — el que sí jugó quedaba
  // esperando para siempre. Pasado el largo máximo del duelo más una gracia,
  // su score 0 lo escribo yo (first-write-wins) y el duelo resuelve igual.
  const duelId = duelIdFor();
  if(G._duelDeadline) clearTimeout(G._duelDeadline);
  G._duelDeadline = setTimeout(()=>{
    G._duelDeadline=null;
    if(!G.running || !G.online || G._duelResolved || G.duel.oppStopped) return;
    Net.pushOppDuelFallback(duelId).catch(e=>console.error('[net] duel fallback', e));
  }, CFG.duelMaxPasses*(CFG.duelCycleDuration/2)*1000 + NET_DUEL_GRACE_MS);
  startDuelRaf(updateIndicatorOnline);
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
  // El timeout de inactividad entra con score 0 — nunca dispara el perfecto.
  if(score===CFG.perfectScore) perfectStopFx();
  Net.pushDuelScore(duelIdFor(), score, pos).catch(e=>console.error('[duel] push', e));
  if(G.duel.oppStopped) resolveDuelOnline();
}

// Llegaron ambos scores desde Firebase. Mapear por rol y resolver.
function onDuelScoresReady(scores){
  if(G._duelDeadline){ clearTimeout(G._duelDeadline); G._duelDeadline=null; }
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
  if(!G.running) return;          // la partida terminó en el medio (abandono rival)
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
  // El rival pudo abandonar durante el revelado (onOpponentLeft ya cerró la
  // partida y mostró la victoria): no aplicar el duelo fantasma encima.
  if(!G.running) return;
  G._duelResolved = true;
  $('duel-reveal').style.display='none';
  if(G.duel.raf){ cancelAnimationFrame(G.duel.raf); G.duel.raf=null; }
  G.phase='duel-result';

  // stats: solo duelos online — ensureAuth() espera a que la sesión (ya en
  // curso) termine de resolverse en vez de asumir currentUser ya disponible
  // (evita perder el guardado si la restauración de sesión todavía no terminó).
  const { isTie, youWin, rawYou, rawOpp, yourRealDmg, oppRealDmg, chip } = applyDuelOutcome();
  if(!isTie){
    if(youWin) ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { damageDealt:yourRealDmg, damageReceived:chip, kills:G.opp.hp<=0?1:0 }); });
    else ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { damageDealt:chip, damageReceived:oppRealDmg }); });
  }
  if(OT.active && OT.inMatch && OT.master){
    const meIsA = (OT.matchA===OT.mySeat);
    const winner = isTie ? 'tie' : (youWin===meIsA ? 'A' : 'B');
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
    setDuelOverlayShown(false);
    G._duelResolved = false;
    if(!G.running) return;   // abandono del rival mientras se mostraba el resultado
    if(G.you.hp<=0||G.opp.hp<=0){ endGame(); return; }
    if(isTie){
      // Reposicionamiento first-write-wins: normalmente lo calcula el host,
      // pero si su pestaña está de fondo (reloj global v0.3.40) el guest lo
      // calcula él mismo al vencer el plazo — antes esperaba para siempre, y
      // el empate 0-0 con un ausente (fallback de score 0) es justo este caso.
      // AMBOS aplican el valor canónico que quedó en Firebase vía el listener.
      setMsg(TEXTS.msgRepositioning, true);
      Net.onEject = (e)=>{
        if(G._ejectDeadline){ clearTimeout(G._ejectDeadline); G._ejectDeadline=null; }
        applyEjectPositions(e);
      };
      Net.listenEject(duelId);
      if(Net.role==='host'){
        const pos = computeEjectPositions();
        Net.pushEject(duelId, pos.you, pos.opp).catch(e=>console.error('[eject] push', e));
      } else {
        if(G._ejectDeadline) clearTimeout(G._ejectDeadline);
        G._ejectDeadline = setTimeout(()=>{
          G._ejectDeadline=null;
          if(!G.running || !G.online) return;
          const pos = computeEjectPositions();
          // el nodo va SIEMPRE en perspectiva del host → el guest cruza you/opp
          Net.pushEject(duelId, pos.opp, pos.you).catch(e=>console.error('[eject] push', e));
        }, NET_EJECT_DEADLINE_MS);
      }
    } else {
      renderBoard(); updateHud(); startChoosePhase();
    }
  }, 2600);
}

// Clases de color de una barra de HP (compartido por el HUD y las columnas de resultado del duelo).
function setHpBarColor(fillEl, pct){
  fillEl.classList.toggle('is-low', pct<25);
  fillEl.classList.toggle('is-mid', pct>=25 && pct<55);
}

// Último HP/pct visto por el HUD, por lado (feedback de daño). null = primer
// sync de la partida: registra sin efectos (evita el flash al arrancar
// campaña/torneo con HP heredado distinto de maxHp).
const HudFx = { you:null, opp:null };

// Daño visible en el HUD (trampa, bomba, goteo del anillo, chip del duelo…):
// pop rojo del número con conteo animado + "ghost bar" (queda pintado el tramo
// perdido y se vacía/desvanece después, estilo juego de pelea). One-shot con
// transiciones inline — mismo precedente que .hp-fill{transition:width}.
// Devuelve true si el número quedó a cargo del tween.
function hudDamageFx(side, prevHp, hpNow, prevPct, pctNow){
  const num=$('hp-num-'+side), ghost=$('hp-ghost-'+side);
  popClass(num,'is-hit');
  tweenNum(num, Math.max(0,prevHp), Math.max(0,hpNow), 400);
  if(ghost){
    ghost.style.transition='none';
    ghost.style.width=prevPct+'%';
    ghost.style.opacity='.5';
    void ghost.offsetWidth;
    ghost.style.transition='width .55s ease .25s, opacity .35s ease .85s';
    ghost.style.width=pctNow+'%';
    ghost.style.opacity='0';
  }
  return true;
}

function updateHud(){
  const oppMax = G.opp.maxHp || CFG.maxHp;
  const youPct=Math.max(0,Math.min(100,(G.you.hp/(G.you.maxHp||CFG.maxHp))*100));
  const oppPct=Math.max(0,Math.min(100,(G.opp.hp/oppMax)*100));
  $('hp-fill-you').style.width=youPct+'%'; $('hp-fill-opp').style.width=oppPct+'%';
  // Feedback de daño: solo con valor previo registrado, partida corriendo y
  // fuera del duelo (el daño del duelo ya se mostró animado en su veredicto;
  // el updateHud que llega con el overlay puesto lo absorbe en silencio).
  const fxOk = G.running && !document.body.classList.contains('is-dueling') && !prefersReduced();
  let youTween=false, oppTween=false;
  if(fxOk && HudFx.you!==null && G.you.hp < HudFx.you.hp)
    youTween = hudDamageFx('you', HudFx.you.hp, G.you.hp, HudFx.you.pct, youPct);
  if(fxOk && HudFx.opp!==null && G.opp.hp < HudFx.opp.hp)
    oppTween = hudDamageFx('opp', HudFx.opp.hp, G.opp.hp, HudFx.opp.pct, oppPct);
  HudFx.you={hp:G.you.hp, pct:youPct}; HudFx.opp={hp:G.opp.hp, pct:oppPct};
  // Sin tween nuevo: cancelar uno viejo si sigue vivo (ej. curación pisándolo)
  // y escribir directo, como siempre.
  [['you',youTween],['opp',oppTween]].forEach(([side,tw])=>{
    if(tw) return;
    const n=$('hp-num-'+side);
    if(n._twnRaf){ cancelAnimationFrame(n._twnRaf); n._twnRaf=null; }
    n.textContent=Math.max(0, G[side].hp);
  });
  setHpBarColor($('hp-fill-you'), youPct);
  setHpBarColor($('hp-fill-opp'), oppPct);
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
  // Entrada animada (is-new) SOLO para chips que aparecen o suben de valor:
  // el innerHTML se rebuildea en cada updateHud y sin esta comparación
  // re-animaría todos los chips en cada render (parpadeo constante).
  const map={ atk:buffs.dmg||0, def:buffs.def||0, ring:(player.ringDrip&&player.ringDrip>0)?1:0, boots:player.boots?1:0 };
  const prev=el._prevBuffs||{};
  const fresh=(k)=> map[k] > (prev[k]||0) ? ' is-new' : '';
  if(buffs.dmg>0){ const c=document.createElement('span'); c.className='buff-chip is-atk'+fresh('atk'); c.innerHTML=`<span class="sym">🗡️</span> +${buffs.dmg}`; el.appendChild(c); }
  if(buffs.def>0){ const c=document.createElement('span'); c.className='buff-chip is-def'+fresh('def'); c.innerHTML=`<span class="sym">◈</span> +${buffs.def}`; el.appendChild(c); }
  // Efecto del anillo activo (goteo de curación): solo el ícono, sin texto.
  if(player.ringDrip && player.ringDrip>0){ const c=document.createElement('span'); c.className='buff-chip is-ring'+fresh('ring'); c.innerHTML=`<span class="ring-ic"></span>`; el.appendChild(c); }
  // 👟 Doble paso listo para el próximo movimiento (Modo Caos)
  if(player.boots){ const c=document.createElement('span'); c.className='buff-chip is-boots'+fresh('boots'); c.innerHTML=`<span class="sym">👟</span> x2`; el.appendChild(c); }
  el._prevBuffs=map;
}
function setMsg(text,active=false){ const el=$('turn-msg'); el.textContent=text; el.classList.toggle('is-active',active); }

// Revancha online: ambos deben aceptar. El host, al estar ambos listos,
// genera un board nuevo y reinicia (reusa el flujo de pushStart/listenStart).
// Mejor de 5: continuar a la siguiente ronda automáticamente.
function setupNextRound(){
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
        Net.pushStart(serializeBoard());
      });
    }, 3000);
  } else {
    $('result-score').innerHTML += '<br><span style="color:var(--muted)">Siguiente ronda…</span>';
  }
  // Si el rival se va entre rondas
  Net.onOpponentLeft = ()=>{ toast(TEXTS.toastSeriesOppLeft); };
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
    toast(TEXTS.toastRoomOppLeft);
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
// Marcador de la serie online (mejor de 3): 3 puntos en orden cronológico de
// rondas. Gris = pendiente; azul = la ganaste vos; negro = la ganó el rival.
function renderRoundDots(){
  const el=$('round-dots'); el.innerHTML='';
  for(let i=0;i<SERIES_ROUNDS;i++){
    const d=document.createElement('span'); d.className='round-dot';
    const w=App.roundHist[i];
    if(w==='you') d.classList.add('is-you');
    else if(w==='opp') d.classList.add('is-opp');
    el.appendChild(d);
  }
}

// Pinta el bloque de EXP en la pantalla de resultado: chip "+N EXP", barra que
// se llena hacia el próximo nivel y, si subió, un flash dorado "¡Nivel N!".
// `res` es lo que devuelve Exp.add (o null → oculta el bloque). Animación de un
// solo disparo (width/opacity), FUERA del duelo → sin costo de rAF; respeta
// prefers-reduced-motion (la barra salta al valor final sin transición).
function showResultExp(res){
  const wrap=$('result-exp'); if(!wrap) return;
  if(!res){ wrap.hidden=true; return; }
  wrap.hidden=false;
  $('result-exp-gain').textContent = fillText('resultExpGain', {n:res.gained});
  $('result-exp-level').textContent = fillText('levelLabel', {n:res.after.level});
  const fill=$('result-exp-fill');
  // Arranca desde la fracción previa y transiciona a la nueva; si subió de nivel
  // arranca de 0 (barra del nivel nuevo) para que se lea el salto.
  const startPct = Math.round((res.leveledUp ? 0 : res.before.frac)*100);
  const endPct   = Math.round(res.after.frac*100);
  if(prefersReduced()){
    fill.style.transition='none'; fill.style.width=endPct+'%';
  } else {
    fill.style.transition='none'; fill.style.width=startPct+'%';
    void fill.offsetWidth;                 // reflow: fija el punto de partida
    fill.style.transition=''; fill.style.width=endPct+'%';
  }
  const flash=$('result-exp-levelup');
  if(res.leveledUp){
    flash.textContent = fillText('levelUpFlash', {n:res.after.level});
    flash.hidden=false;
    if(!prefersReduced()) popClass(flash, 'is-show');
  } else {
    flash.hidden=true;
  }
}

function endGame(){
  G.running=false; G.phase='gameover';
  clearNetDeadlines();
  const youHp=Math.max(0,G.you.hp), oppHp=Math.max(0,G.opp.hp);
  const youWon = youHp>oppHp;
  const nextBtn=$('btn-tourney-next'), againBtn=$('btn-again');
  nextBtn.style.display='none'; againBtn.style.display='block';
  const roomBtn=$('btn-to-room'); roomBtn.style.display='none';
  const campBtn=$('btn-camp-next'); campBtn.style.display='none';
  const rt=$('result-title'); rt.classList.remove('is-win','is-lose','is-champion');
  $('tourney-progress').innerHTML='';   // solo la rama de Tourney offline la llena
  $('round-dots').innerHTML='';         // solo la serie online lo llena (renderRoundDots)
  showHealPop(0);                       // solo la victoria de ronda de Tourney lo re-muestra
  showResultExp(null);                  // cada rama que otorga EXP lo re-muestra

  // --- Torneo online x4: el resultado va al bracket, no a la pantalla clásica ---
  if(OT.active && OT.inMatch){ OT.onMyMatchEnd(youHp, oppHp); return; }

  // --- Fin de partida ONLINE ---
  if(G.online){
    const isTie = (youHp===oppHp);
    // Serie (mejor de 3): actualizar marcador (los empates no suman a nadie)
    if(App.matchMode==='bo5' && !isTie){
      if(youHp>oppHp){ App.scoreYou++; App.roundHist.push('you'); }
      else           { App.scoreOpp++; App.roundHist.push('opp'); }
    }
    const matchOver = App.matchMode!=='bo5' ||
                      App.scoreYou>=BO5_TARGET || App.scoreOpp>=BO5_TARGET;

    $('result-eyebrow').textContent = (App.matchMode==='bo5')
      ? fillText('resultBo5Eyebrow', {scoreYou:App.scoreYou, scoreOpp:App.scoreOpp}) : TEXTS.resultFinalEyebrow;

    if(isTie)              $('result-title').textContent=TEXTS.resultTieTitle;
    else if(youHp>oppHp)   $('result-title').textContent= matchOver ? TEXTS.resultWinTitle : TEXTS.resultWinRoundTitle;
    else                   $('result-title').textContent= matchOver ? TEXTS.resultLoseTitle : TEXTS.resultLoseRoundTitle;

    if(App.matchMode==='bo5'){
      $('result-score').innerHTML=`${fillText('resultScoreRounds',{scoreYou:App.scoreYou, scoreOpp:App.scoreOpp})}<br><span style="color:var(--muted)">${youHp} HP vs ${oppHp} HP</span>`;
      renderRoundDots();
    } else {
      $('result-score').innerHTML=fillText('resultScoreHp', {youHp, oppHp});
    }
    againBtn.style.display='none';

    if(matchOver){
      let won = isTie ? null : (youHp>oppHp);
      if(App.matchMode==='bo5'){
        const champ = App.scoreYou>App.scoreOpp;
        $('result-title').textContent = champ ? TEXTS.resultWinSeriesTitle : TEXTS.resultLoseSeriesTitle;
        won = champ;
      }
      if(won===true)  rt.classList.add('is-win');
      if(won===false) rt.classList.add('is-lose');
      // Sting solo en el resultado FINAL de la serie (las rondas intermedias
      // ya tuvieron su sonido en el veredicto del duelo).
      if(won===true){ Sound.fanfare(); haptic([15,30,15]); }
      else if(won===false){ Sound.loseSting(); haptic([20,60,20]); }
      else Sound.tie();
      ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { gamesPlayed:1, gamesWon: won===true?1:0 }); });
      // EXP solo en el resultado FINAL de la serie (las rondas intermedias no,
      // igual que las stats). Empate (won===null) rinde como derrota.
      showResultExp(grantBattleExp(won===true ? 'win' : 'lose', 'online'));
      App.scoreYou=0; App.scoreOpp=0; App.roundHist=[];   // reset para futuras series
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
    $('result-eyebrow').textContent=TEXTS.resultFinalEyebrow;
    $('result-score').innerHTML=fillText('resultScoreHp', {youHp, oppHp});
    if(youWon){
      $('result-title').textContent=TEXTS.resultWinTitle;
      rt.classList.add('is-win');
      Sound.fanfare(); haptic([15,30,15]);
      Campaign.completeCurrent();      // cachea el avance YA (aunque cierre la app)
      againBtn.style.display='none';
      campBtn.style.display='block';
    } else {
      $('result-title').textContent = (youHp===oppHp) ? TEXTS.resultTieTitle : TEXTS.resultLoseTitle;
      if(youHp<oppHp){ rt.classList.add('is-lose'); Sound.loseSting(); haptic([20,60,20]); }
      againBtn.textContent=TEXTS.campaignRetryLabel;   // vuelve a jugar el mismo nodo
    }
    // Rejugar un nodo ya superado rinde como práctica (no farmear niveles viejos).
    showResultExp(grantBattleExp(youWon ? 'win' : 'lose', Campaign.replaying ? 'practice' : 'offline'));
    show('result');
    return;
  }

  if(Tourney.active){
    const r=TOURNEY_ROSTER[Tourney.index];
    const isLast = Tourney.index >= TOURNEY_ROSTER.length-1;
    if(youWon && isLast){
      Tourney._carryHp = youHp;
      $('result-eyebrow').textContent=TEXTS.tourneyChampionEyebrow;
      $('result-title').textContent=TEXTS.tourneyChampionTitle;
      $('result-score').innerHTML=fillText('tourneyChampionScore', {name:r.name, hp:youHp});
      againBtn.style.display='none';
      Tourney._beaten = Tourney.index;   // venció a todos
      Tourney.active=false;
      Tourney._carryHp=null;             // reset para el próximo torneo
      rt.classList.add('is-win','is-champion');
      Sound.champion(); haptic([20,40,20,40,60]);
    } else if(youWon){
      // Recupera 30% (redondeado) de la vida máxima del rival recién derrotado.
      const heal = Math.round(tourneyHpFor(Tourney.index) * 0.3);
      const healedHp = Math.min(TOURNEY_YOU_HP, youHp + heal);
      Tourney._carryHp = healedHp;       // conserva la vida (con cura) para la próxima ronda
      Tourney._beaten = Tourney.index;   // último vencido
      $('result-eyebrow').textContent=fillText('tourneyRoundEyebrow', {i:Tourney.index+1, n:TOURNEY_ROSTER.length});
      $('result-title').textContent=fillText('tourneyBeatOpp', {name:r.name});
      $('result-score').innerHTML=fillText('tourneyHpLeft', {hp:healedHp});
      showHealPop(Math.min(heal, TOURNEY_YOU_HP - youHp));
      againBtn.style.display='none';
      nextBtn.style.display='block';
      rt.classList.add('is-win');
      Sound.win(); haptic([15,30,15]);
    } else {
      $('result-eyebrow').textContent=TEXTS.tourneyEyebrow;
      $('result-title').textContent=TEXTS.tourneyEliminatedTitle;
      $('result-score').innerHTML=fillText('tourneyEliminatedScore', {i:Tourney.index+1, n:TOURNEY_ROSTER.length, name:r.name});
      againBtn.textContent=TEXTS.tourneyRetryLabel;
      Tourney.active=true; // permitir reintentar el mismo (conserva _carryHp de la ronda anterior)
      rt.classList.add('is-lose');
      Sound.loseSting(); haptic([20,60,20]);
    }
    // EXP offline por cada ronda ganada (y el título); eliminación rinde derrota.
    showResultExp(grantBattleExp(youWon ? 'win' : 'lose', 'offline'));
    renderTourneyProgress();
    pulseResultTitle(rt);
    show('result');
    return;
  }

  // --- Práctica / partida suelta vs CPU offline ---
  $('result-eyebrow').textContent=TEXTS.resultFinalEyebrow;
  if(youHp===oppHp)      { $('result-title').textContent=TEXTS.resultTieTitle; Sound.tie(); }
  else if(youHp>oppHp)   { $('result-title').textContent=TEXTS.resultWinTitle; Sound.fanfare(); haptic([15,30,15]); }
  else                   { $('result-title').textContent=TEXTS.resultLoseTitle; Sound.loseSting(); haptic([20,60,20]); }
  $('result-score').innerHTML=fillText('resultScoreHp', {youHp, oppHp});
  showResultExp(grantBattleExp(youWon ? 'win' : 'lose', 'practice'));
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
    this._keepRoom = false;

    await this.ref.set({
      status: 'waiting',
      host: { name: App.playerName, user: User.name || null, skin: (User.name && Profile.skin!=='default') ? Profile.skin : null },
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
        App.oppSkin = g.skin || null;
        this.ref.child('status').set('ready');
        if(this.onReady) this.onReady({ role:'host', oppName:g.name });
      } else if(this._sawGuest && G.running && G.online && !OT.active){
        // v0.3.41: el nodo guest se borró EN PLENA PARTIDA — solo Net.leave()
        // lo hace (salida deliberada con el botón, o su forfeit local por
        // idle): victoria inmediata, sin esperar la racha de auto-movimientos.
        this._sawGuest = false;
        winByAbandon();
      } else if(this._sawGuest && !G.running && this.ref){
        // El invitado se fue del lobby (o se le cortó): volver a esperar
        this._sawGuest = false;
        this.ref.child('status').set('waiting');
        if(this.onGuestLeft) this.onGuestLeft();
      }
    });
    return code;
  },

  // Borra salas con más de 2 horas de antigüedad (limpieza oportunista, #13).
  // Query indexada por createdAt (.indexOn en database.rules.json): baja SOLO
  // las salas vencidas — antes hacía .get() de rooms/ entero (todas las salas
  // activas con sus games y chats) para después filtrar en el cliente.
  async cleanStaleRooms(){
    if(!fbDb) return;
    const TWO_HOURS = 2*60*60*1000;
    const cutoff = Date.now() - TWO_HOURS;
    const snap = await fbDb.ref('rooms').orderByChild('createdAt').endAt(cutoff).get();
    if(!snap.exists()) return;
    const dels = [];
    // Las salas sin createdAt (datos viejos) ordenan primero → también entran.
    snap.forEach(child=>{ dels.push(child.ref.remove().catch(()=>{})); });
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
    this._keepRoom = false;
    App.oppName = (room.host && room.host.name) || 'Rival';
    App.oppUser = (room.host && room.host.user) || null;
    App.oppSkin = (room.host && room.host.skin) || null;

    await ref.child('guest').set({ name: App.playerName, user: User.name || null, skin: (User.name && Profile.skin!=='default') ? Profile.skin : null });
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
    this._lastBoardStr = boardStr;
    await this.ref.child('game').set({
      board: boardStr,
      turn: 0,
      mode: App.matchMode,   // 'single' | 'bo5'
      startedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await this.ref.child('status').set('playing');
  },

  // Ambos: escuchan el arranque de la partida (cuando aparece game.board)
  // Callback guardado en _startCb: listenBoard() escucha el mismo path
  // ('game/board'), así que stopListenStart() debe sacar SOLO su propio
  // listener y no un .off() a secas (eso se llevaría puesto también el de
  // listenBoard, cortando la actualización de ítems del guest a mitad de ronda).
  // ⚠️ .on('value') dispara INMEDIATAMENTE con el valor actual: al armarse
  // entre rondas de una serie (o en la pantalla de fin), game/board todavía
  // tiene el tablero VIEJO de la ronda que acaba de terminar, y ese primer
  // evento arrancaba la ronda al instante (pantalla de resultado que "se pasa
  // en menos de 1 segundo") sobre un board que el host pisaba 3s después
  // (segunda ronda injugable). Fix: _lastBoardStr recuerda el último board
  // visto en el wire; al armar el listener se congela ese valor como "viejo"
  // y solo un board DISTINTO dispara onStart (el host siempre genera un board
  // nuevo tras resetForRematch, así que el string nunca se repite).
  _startCb: null,
  _lastBoardStr: null,
  listenStart(){
    if(!this.ref) return;
    this.stopListenStart();   // idempotente: nunca dos listeners de start a la vez
    const stale = this._lastBoardStr;   // board de la ronda que acaba de terminar (o null)
    this._startCb = s=>{
      const b = s.val();
      if(!b || b===stale || !this.onStart) return;
      this._lastBoardStr = b;
      // Leer el modo elegido por el host (guest lo recibe)
      this.ref.child('game/mode').get().then(ms=>{
        App.matchMode = ms.val() || 'single';
        this.onStart(b);
      }).catch(()=>this.onStart(b));
    };
    this.ref.child('game/board').on('value', this._startCb);
  },

  stopListenStart(){
    if(this.ref && this._startCb){ this.ref.child('game/board').off('value', this._startCb); this._startCb=null; }
  },

  // ---- Revancha online (#6) ----
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

  // Escritura first-write-wins (reloj global v0.3.40): solo escribe si el nodo
  // está vacío. El valor que queda en Firebase es el canónico para AMBOS
  // clientes — la escritura tardía de una pestaña de fondo que despierta
  // pierde en silencio (la transaction aborta al devolver undefined).
  // applyLocally=false: el listener nunca ve el valor optimista local de una
  // transaction que después aborta, solo estado confirmado por el server.
  _setIfAbsent(path, value){
    if(!this.ref) return Promise.resolve(null);
    return this.ref.child(path).transaction(cur => (cur===null ? value : undefined), null, false);
  },
  _oppKey(){ return this.role==='host' ? 'guest' : 'host'; },

  // Sube mi movimiento (coords canónicas) para el turno dado. Los turnos viejos
  // ya NO se limpian: un cliente que vuelve de pestaña de fondo se pone al día
  // leyendo los turnos que se perdió (el nodo game/ entero se borra igual en
  // revancha/leave, y el peso por turno es trivial).
  async pushMove(turn, x, y){
    await this._setIfAbsent('game/moves/'+turn+'/'+this.role, { x, y });
  },

  // Reloj global: move de fallback del RIVAL ausente (lo decide mi cliente;
  // lo que quede escrito es canónico, así que el azar del desempate no importa).
  pushOppMoveFallback(turn, x, y){
    return this._setIfAbsent('game/moves/'+turn+'/'+this._oppKey(), { x, y });
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
    this._lastBoardStr = boardStr;
    await this.ref.child('game/board').set(boardStr);
  },

  // Escucha actualizaciones de board (para el guest tras regeneración).
  // Idempotente (mismo patrón que listenStart): en una serie se llama una vez
  // POR RONDA y sin soltar el listener anterior se apilaban duplicados — en la
  // ronda N cada update de board disparaba N renders en el guest.
  _boardCb: null,
  listenBoard(){
    if(!this.ref) return;
    this.stopListenBoard();
    this._boardCb = s=>{
      const b = s.val();
      if(b) this._lastBoardStr = b;   // recuerda el board vigente (ver listenStart)
      if(b && this.onBoardUpdate) this.onBoardUpdate(b);
    };
    this.ref.child('game/board').on('value', this._boardCb);
  },

  stopListenBoard(){
    if(this.ref && this._boardCb){ this.ref.child('game/board').off('value', this._boardCb); this._boardCb=null; }
  },

  // ---- Duelo sincronizado (Etapa 3B) ----
  onDuelScores: null,   // callback(scoresObj) cuando están los dos scores
  onEject: null,        // callback(positions) cuando el host resuelve un empate
  _duelRef: null,

  // Sube mi resultado del duelo (score + posición de aguja) para este encuentro
  async pushDuelScore(duelId, score, pos){
    await this._setIfAbsent('game/duels/'+duelId+'/'+this.role, { score, pos });
  },

  // Reloj global: el rival ausente no cometió ni el score 0 (rAF congelado) →
  // el 0 lo escribo yo y el duelo resuelve para los dos.
  pushOppDuelFallback(duelId){
    return this._setIfAbsent('game/duels/'+duelId+'/'+this._oppKey(), { score:0, pos:0 });
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

  // Posiciones tras un eject (empate), SIEMPRE en perspectiva del host.
  // First-write-wins: normalmente escribe el host, pero el guest lo calcula él
  // si el host no aparece (reloj global) — ambos aplican el valor que quedó.
  async pushEject(duelId, youPos, oppPos){
    await this._setIfAbsent('game/ejects/'+duelId, { youPos, oppPos });
  },
  listenEject(duelId){
    if(!this.ref) return;
    this.ref.child('game/ejects/'+duelId).on('value', s=>{
      const e = s.val();
      if(e && this.onEject){ this.ref.child('game/ejects/'+duelId).off(); this.onEject(e); }
    });
  },

  // ---- 🪨📄✂️ Piedra-papel-tijera por buff compartido ----
  // Mismo modelo que los scores del duelo: cada cliente sube SOLO su pick
  // (número 0-2) a game/rps/{rpsId}/{rol}; con ambos presentes, las dos
  // pantallas resuelven idéntico. rpsId = 'r'+turno (pre-incremento).
  onRpsPicks: null,      // callback(picksObj) cuando están los dos picks
  onOppRpsPicked: null,  // callback apenas aparece el pick del rival (aviso parcial)
  _rpsRef: null,
  async pushRpsPick(rpsId, pick){
    await this._setIfAbsent('game/rps/'+rpsId+'/'+this.role, pick);
  },

  // Reloj global: "no elección" (3) del rival ausente al vencer su plazo.
  pushOppRpsFallback(rpsId){
    return this._setIfAbsent('game/rps/'+rpsId+'/'+this._oppKey(), RPS_NO_PICK);
  },
  listenRpsPicks(rpsId){
    if(!this.ref) return;
    if(this._rpsRef) this._rpsRef.off();
    this._rpsRef = this.ref.child('game/rps/'+rpsId);
    const oppKey = this.role==='host' ? 'guest' : 'host';
    this._rpsRef.on('value', s=>{
      const p = s.val();
      if(!p) return;
      // 0 es falsy: comparar contra null, nunca truthiness
      if(p[oppKey]!=null && this.onOppRpsPicked) this.onOppRpsPicked();
      if(p.host!=null && p.guest!=null && this.onRpsPicks){
        this._rpsRef.off(); this._rpsRef=null;
        this.onRpsPicks(p);
      }
    });
  },
  stopRpsListen(){
    if(this._rpsRef){ this._rpsRef.off(); this._rpsRef=null; }
  },

  // ---- 🏁 Fin unilateral de partida (game/over, v0.3.41) ----
  // El ganador por inactividad lo escribe (first-write-wins) y el que estaba
  // desconectado lo encuentra al volver: ve su derrota en vez de una partida
  // viva. Mientras exista, leave() conserva la sala (ver _keepRoom).
  onGameOver: null,
  _overRef: null,
  _keepRoom: false,
  pushGameOver(winnerRole){
    return this._setIfAbsent('game/over', { winner: winnerRole, reason: 'idle' });
  },
  listenGameOver(){
    if(!this.ref) return;
    this.stopGameOver();
    this._overRef = this.ref.child('game/over');
    this._overRef.on('value', s=>{
      const o = s.val();
      if(o && this.onGameOver) this.onGameOver(o);
    });
  },
  stopGameOver(){
    if(this._overRef){ this._overRef.off(); this._overRef=null; }
  },

  // ---- Sala viva (v0.3.41, solo guest 1v1) ----
  // createdAt es un escalar estable: si desaparece con la partida en curso, el
  // host borró la sala con Net.leave() (salida deliberada SIN marcador) — el
  // guest gana al instante. La derrota del que vuelve tarde nunca entra por
  // acá: el ganador conserva la sala (con game/over adentro) al salir.
  onRoomGone: null,
  _aliveRef: null,
  _roomSeen: false,
  listenRoomAlive(){
    if(!this.ref) return;
    this.stopRoomAlive();
    this._aliveRef = this.ref.child('createdAt');
    this._aliveRef.on('value', s=>{
      const v = s.val();
      if(v!=null){ this._roomSeen = true; return; }
      if(this._roomSeen && this.onRoomGone) this.onRoomGone();
    });
  },
  stopRoomAlive(){
    if(this._aliveRef){ this._aliveRef.off(); this._aliveRef=null; }
    this._roomSeen=false;
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
        // Volvió durante la gracia → cancelar el aviso; o DESPUÉS de la gracia
        // (v0.3.41: el watcher ya no se suelta — la partida siguió sola con el
        // reloj global y el rival puede reengancharse) → avisar igual.
        if(this._graceTimer){
          clearTimeout(this._graceTimer); this._graceTimer=null;
          if(this.onOpponentBack) this.onOpponentBack();
        } else if(this._oppGone){
          if(this.onOpponentBack) this.onOpponentBack();
        }
        this._oppGone = false;
        return;
      }
      // Rival ausente: dar unos segundos por si reconecta
      if(this._oppSeen && !this._graceTimer && !this._oppGone){
        if(this.onOpponentWaiting) this.onOpponentWaiting();
        this._graceTimer = setTimeout(()=>{
          this._graceTimer=null;
          this._oppGone = true;   // v0.3.41: seguir vigilando (antes: off())
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
    this._presenceWatch=false; this._oppPresRef=null; this._oppSeen=false; this._oppGone=false;
  },

  // Suelta los listeners de una partida de torneo SIN borrar nada de la sala
  detachMatch(){
    try {
      this.cancelGuestSlotCleanup();
      this.stopPresence();
      this.stopChat();
      if(this._movesRef){ this._movesRef.off(); this._movesRef=null; }
      if(this._duelRef){ this._duelRef.off(); this._duelRef=null; }
      this.stopRpsListen();
      this.stopGameOver();
      this.stopRoomAlive();
      if(this.ref){ this.ref.child('game/board').off(); this.ref.off(); }
    } catch(e){}
    this.ref=null; this.role=null; this._startCb=null; this._boardCb=null; this._lastBoardStr=null;
    this.onOpponentLeft=null; this.onMovesReady=null; this.onDuelScores=null;
    this.onBoardUpdate=null; this.onStart=null; this.onEject=null;
    this.onRpsPicks=null; this.onOppRpsPicked=null;
    this.onOpponentWaiting=null; this.onOpponentBack=null;
    this.onGameOver=null; this.onRoomGone=null;
  },

  leave(){
    App.oppUser = null;
    App.oppSkin = null;
    try {
      this.cancelGuestSlotCleanup();
      this.stopPresence();
      this.stopChat();
      if(this._movesRef){ this._movesRef.off(); this._movesRef=null; }
      if(this._duelRef){ this._duelRef.off(); this._duelRef=null; }
      this.stopRpsListen();
      this.stopGameOver();
      this.stopRoomAlive();
      if(this.ref){
        this.ref.child('game/board').off();
        this.ref.child('guest').off();
        this.ref.off();
        // El host borra la sala entera; el invitado solo se quita. v0.3.41:
        // con marcador game/over la sala se CONSERVA para que el desconectado
        // encuentre su derrota al volver (cleanStaleRooms la purga después).
        if(this.role==='host' && !this._keepRoom) this.ref.remove();
        else if(this.role==='guest') this.ref.child('guest').remove();
      }
    } catch(e){ console.warn('[Rally] Net.leave', e); }
    this.ref=null; this.code=null; this.role=null; this.onReady=null;
    this._startCb=null; this._boardCb=null; this._lastBoardStr=null;
    this.onGuestLeft=null; this._sawGuest=false;
    this.onOpponentLeft=null; this.onMovesReady=null; this.onDuelScores=null;
    this.onBoardUpdate=null; this.onStart=null; this.onEject=null;
    this.onRpsPicks=null; this.onOppRpsPicked=null;
    this.onGameOver=null; this.onRoomGone=null; this._keepRoom=false;
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
const CPU_NAMES = TEXTS.cpuNamesPool.split('\n').map(s=>s.trim()).filter(Boolean);

const OT = {
  active:false, ref:null, code:null, mySeat:null,
  uid: Math.random().toString(36).slice(2,10),
  players:{}, br:null, _phase:null, _leaving:false,
  inMatch:false, myMatchId:null, matchA:null, matchB:null, master:false,
  myDone:false, eliminated:false, finished:false, _finalHandled:false,
  specId:null, _specRef:null, _specSeats:null,
  _champBumped:false,   // evita sumar "torneos ganados" más de una vez por torneo
  _resultSoundPlayed:false,   // evita repetir sonido/haptic en cada re-render del hub
  _lastYouHp:null, _lastOppHp:null,   // HP final de tu último partido (recap en el hub)
  _lastExpRes:null,                   // EXP ganado en tu último partido (recap en el hub)

  resetRunFlags(){
    this.inMatch=false; this.myMatchId=null; this.matchA=null; this.matchB=null;
    this.master=false; this.myDone=false; this.eliminated=false;
    this.finished=false; this._finalHandled=false; this._champBumped=false;
    this._resultSoundPlayed=false; this._lastYouHp=null; this._lastOppHp=null; this._lastExpRes=null; this.stopSpec();
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
        if(this.active && !this._leaving){ toast(TEXTS.toastRoomClosed); this.cleanupLocal(); G.running=false; hideRpsOverlay(); clearNetDeadlines(); show('home'); }
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
            toast(TEXTS.toastTourneyFinal);
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
    if(DEMO || !fbDb){ toast(TEXTS.toastNeedConnection); return false; }
    if(!Net.ref || Net.role!=='host'){ toast(TEXTS.toastCreateRoomFirst); return false; }
    try{
      const g=(await Net.ref.child('guest').get()).val();
      if(g && g.name){ toast(TEXTS.toastChangeModeBeforeJoin); return false; }
    }catch(e){}
    const players={ s0:{ name:App.playerName||'Jugador', color:SEAT_COLORS.s0, uid:this.uid, user:User.name||null, skin:(User.name && Profile.skin!=='default') ? Profile.skin : null } };
    await Net.ref.update({ type:'tourney', players, guest:null, status:'waiting' });
    this.setup(Net.ref, Net.code, 's0');
    this.showLobby();
    return true;
  },

  // Volver de torneo a sala 2p (solo si no entró nadie más)
  disableTourney(){
    const others=Object.keys(this.players||{}).filter(k=>k!=='s0');
    if(others.length){ toast(TEXTS.toastTourneyFull); return false; }
    const ref=this.ref, code=this.code;
    this._leaving=true;                    // evita el aviso de "sala cerrada"
    this.cleanupLocal();
    ref.update({ type:null, players:null, status:'waiting' });
    Net.ref=ref; Net.code=code; Net.role='host';
    $('ot-box').style.display='none';
    $('wait-text').textContent=TEXTS.waitTextWaitingOpp;
    return true;
  },

  // GUEST: reclamar un asiento libre (transacción por asiento)
  async joinAsGuest(ref, code){
    const room=(await ref.get()).val()||{};
    if(room.status==='playing') return { ok:false, reason:'llena' };
    let claimed=null;
    for(const s of ['s1','s2','s3']){
      const r=await ref.child('players/'+s).transaction(cur=>{
        if(cur===null) return { name:App.playerName||'Jugador', color:SEAT_COLORS[s], uid:OT.uid, user:User.name||null, skin:(User.name && Profile.skin!=='default') ? Profile.skin : null };
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
    $('wait-text').textContent= host ? TEXTS.waitTextCpuFill : TEXTS.waitTextHostWillStart;
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
        const tag = (s===this.mySeat) ? TEXTS.otTagYou : (s==='s0' ? TEXTS.otTagHost : (p.cpu?TEXTS.otTagCpu:''));
        const userTxt = p.user ? ` <span class="ot-user">${escHtml(p.user)}</span>` : '';
        row.innerHTML=`<span class="p-dot" style="background:${p.color||CPU_GRAY}"></span><span>${escHtml(p.name)}${userTxt}</span><span class="ot-tag">${tag}</span>`;
      } else {
        row.className='ot-row is-free';
        row.innerHTML=`<span class="p-dot" style="background:${CPU_GRAY}"></span><span>${TEXTS.otSlotFree}</span><span class="ot-tag">${TEXTS.otSlotFreeTag}</span>`;
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
    }catch(e){ console.warn(e); toast(TEXTS.toastTourneyStartFail); }
    btn.disabled=false; btn.textContent='▸ Iniciar torneo';
  },

  // ---- Ruteo de partidas ----
  async route(){
    this._phase='playing';
    this.myDone=false; this.eliminated=false; this.finished=false; this._finalHandled=false; this._champBumped=false;
    this._resultSoundPlayed=false; this._lastYouHp=null; this._lastOppHp=null; this._lastExpRes=null;
    try{ this.ref.child('players/'+this.mySeat).onDisconnect().cancel(); }catch(e){}
    let r1=null;
    try{
      const snap = await this.ref.get();   // un solo viaje de red: players + bracket/r1 vienen del mismo snapshot
      this.players = snap.child('players').val() || this.players;
      r1 = snap.child('bracket/r1').val();
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
    // Ni Paredes NI Caos en torneo x4 (antes solo se apagaba Paredes: un Caos
    // activado antes generaba boards "C~…" que rompían al espectador y
    // filtraban el modo a rivales que no lo eligieron).
    if(App.wallsMode || App.chaosMode) exitSpecialMode();
    const oppSeat=(a===this.mySeat)?b:a;
    const me=this.players[this.mySeat], opp=this.players[oppSeat];
    App.oppName=opp.name;
    App.oppUser=opp.user||null;
    App.oppSkin=opp.skin||null;
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
    if(wasOnline){   // partida vs humano real (no CPU de relleno) → cuenta para stats y EXP
      ensureAuth().then(u=>{ if(u) Stats.bumpMany(u.uid, { gamesPlayed:1, gamesWon: winner===this.mySeat?1:0 }); });
      this._lastExpRes = grantBattleExp(winner===this.mySeat ? 'win' : 'lose', 'online');
    } else this._lastExpRes = null;
    if(G.online) Net.detachMatch();
    G.online=false; G.running=false;
    this.inMatch=false; this.myDone=true;
    if(winner!==this.mySeat) this.eliminated=true;
    this._lastYouHp=youHp; this._lastOppHp=oppHp;   // recap de HP en el hub
    this.clearColors();
    show('othub'); this.renderHub();
    pulseResultTitle($('othub-title'));
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
    title.classList.remove('is-win','is-lose','is-champion');
    const expLine = this._lastExpRes
      ? `<br><span style="font-size:12px; color:var(--accent);">${fillText('resultExpGain', {n:this._lastExpRes.gained})} · ${fillText('levelLabel', {n:this._lastExpRes.after.level})}</span>` : '';
    const hpRecap = (this._lastYouHp!=null
      ? `<br><span style="font-size:13px;">${fillText('resultScoreHp', {youHp:this._lastYouHp, oppHp:this._lastOppHp})}</span>` : '') + expLine;
    if(this.finished && fw){
      const champ=this.players[fw]||{};
      if(fw===this.mySeat){
        title.textContent=TEXTS.otChampionTitle; title.classList.add('is-win','is-champion');
        if(!this._champBumped){
          this._champBumped = true;
          ensureAuth().then(u=>{ if(u) Stats.bump(u.uid, 'tournamentsWon', 1); });
        }
        if(!this._resultSoundPlayed){ this._resultSoundPlayed=true; Sound.champion(); haptic([20,40,20,40,60]); }
        sub.innerHTML=fillText('otChampionSub', {
          dot:`<span class="p-dot" style="background:${champ.color||CPU_GRAY}"></span>`,
          name:escHtml(champ.name||'?')
        }) + hpRecap;
      }
      else if((w0===this.mySeat||w1===this.mySeat)){
        title.textContent=TEXTS.otLostFinalTitle; title.classList.add('is-lose');
        if(!this._resultSoundPlayed){ this._resultSoundPlayed=true; Sound.loseSting(); haptic([20,60,20]); }
        sub.innerHTML=fillText('otChampionSub', {
          dot:`<span class="p-dot" style="background:${champ.color||CPU_GRAY}"></span>`,
          name:escHtml(champ.name||'?')
        }) + hpRecap;
      }
      else {
        title.textContent=TEXTS.otFinishedTitle;
        sub.innerHTML=fillText('otChampionSub', {
          dot:`<span class="p-dot" style="background:${champ.color||CPU_GRAY}"></span>`,
          name:escHtml(champ.name||'?')
        });
      }
    } else if(this.eliminated){
      title.textContent=TEXTS.tourneyEliminatedTitle; title.classList.add('is-lose');
      if(!this._resultSoundPlayed){ this._resultSoundPlayed=true; Sound.loseSting(); haptic([20,60,20]); }
      sub.innerHTML=TEXTS.otEliminatedSub + hpRecap;
    } else if(this.myDone){
      title.textContent=TEXTS.otSemiWonTitle; title.classList.add('is-win');
      if(!this._resultSoundPlayed){ this._resultSoundPlayed=true; Sound.win(); haptic([15,30,15]); }
      sub.innerHTML=TEXTS.otWaitingFinalist + hpRecap;
    } else {
      title.textContent=TEXTS.otInProgressTitle; sub.textContent='';
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
        btn.className='btn btn--outline'; btn.textContent=TEXTS.otSpectateBtn;
        btn.addEventListener('click', ()=>OT.spectate(mid, a, bSeat));
        box.appendChild(btn);
      }
      list.appendChild(box);
    };
    if(r1.m0) addMatch(TEXTS.otSemi1Label,'m0', r1.m0.a, r1.m0.b, w0, !w0);
    if(r1.m1) addMatch(TEXTS.otSemi2Label,'m1', r1.m1.a, r1.m1.b, w1, !w1);
    if(w0 && w1) addMatch(TEXTS.otFinalLabel,'f', w0, w1, fw, !fw);
  },

  // ---- Espectador ----
  spectate(mid, a, b){
    this.stopSpec();
    this.specId=mid; this._specSeats={a,b};
    this._specRef=this.ref.child('matches/'+mid);
    $('spec-board').innerHTML=''; $('spec-note').textContent=TEXTS.specConnecting;
    this.renderSpecHead(null);
    show('spectate');
    this._specRef.child('spec').on('value', s=>this.renderSpec(s.val()));
    this._specRef.child('result').on('value', s=>{
      const r=s.val();
      if(r && r.winner){
        const p=this.players[r.winner]||{};
        $('spec-note').textContent=fillText('specMatchWon', {name:p.name||'?'});
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
    if(!spec){ $('spec-note').textContent=TEXTS.specWaitingData; return; }
    if(spec.note==='cpu'){
      $('spec-board').innerHTML='';
      $('spec-note').textContent=TEXTS.specCpuVsCpu;
      this.renderSpecHead(null);
      return;
    }
    this.renderSpecHead(spec);
    const st=this._specSeats||{};
    if(spec.duel && spec.duel.active){
      $('spec-note').textContent=TEXTS.specDuelInProgress;
    } else if(spec.duel && spec.duel.active===false){
      const pa=this.players[st.a]||{}, pb=this.players[st.b]||{};
      // Sin escHtml: va por textContent (escapar acá mostraba '&lt;' literal).
      $('spec-note').textContent = (spec.duel.winner==='tie')
        ? fillText('specDuelTie', {scoreA:spec.duel.scoreA, scoreB:spec.duel.scoreB})
        : fillText('specDuelWon', {name:(spec.duel.winner==='A'?pa:pb).name||'?', scoreA:spec.duel.scoreA, scoreB:spec.duel.scoreB});
    } else {
      $('spec-note').textContent=fillText('specTurn', {n:spec.turn||0});
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
      appendCellItemIcon(div, t);
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
    const fallback = NPC_SPRITES[o.name] || {};
    G.spriteOpp = o.sprite || fallback.idle || null;
    G.spriteOppMove = o.spriteMove || fallback.move || null;
    // Precarga de la variante de movimiento: su URL recién se pinta cuando
    // flipMarker() arranca el PRIMER deslizamiento, y la descarga no llega
    // dentro de los 0.35s que dura el trayecto (el primer movimiento se veía
    // con el idle). Disparando el fetch acá, ya está en caché para ese FLIP.
    if(G.spriteOppMove) new Image().src = G.spriteOppMove;
    return;
  }
  G.spriteOpp = null;
  G.spriteOppMove = null;
  if(Tourney.active){
    const r=TOURNEY_ROSTER[Tourney.index];
    root.style.setProperty('--opp-accent', r.accent);
    App.oppName=r.name;
  } else {
    root.style.removeProperty('--opp-accent');
    if(!OT.active) root.style.removeProperty('--you-accent');
  }
}

// Re-dispara la animación de entrada (.is-pulse) del título de resultado.
function pulseResultTitle(el){
  popClass(el,'is-pulse');
}
function showHealPop(amount){
  const el=$('heal-pop');
  if(!amount || amount<=0){ el.classList.remove('is-show'); el.textContent=''; return; }
  el.textContent = `+${amount} HP`;
  popClass(el,'is-show');
}

// Fila compacta de chips (uno por rival del roster) para #screen-result,
// mismo criterio is-beaten/is-current/is-king que showTourneyBracket() pero
// en formato horizontal (ahí es una lista vertical tipo "Mortal Kombat").
function renderTourneyProgress(){
  const wrap = $('tourney-progress'); wrap.innerHTML='';
  TOURNEY_ROSTER.forEach((r,i)=>{
    const chip=document.createElement('span'); chip.className='tp-chip';
    if(r.trait==='luck') chip.classList.add('is-king');
    if(i<=Tourney._beaten) chip.classList.add('is-beaten');
    if(i===Tourney.index && Tourney.active) chip.classList.add('is-current');
    chip.textContent = r.emoji || '●';
    wrap.appendChild(chip);
  });
}

// Pantalla "Mortal Kombat": tu nombre vs la lista de rivales apilados.
// Rey Julian arriba en dorado; vencidos tachados en rojo; el actual resaltado.
function showTourneyBracket(onGo){
  const youHp = (Tourney._carryHp!=null) ? Tourney._carryHp : TOURNEY_YOU_HP;
  $('bracket-you-name').textContent = App.playerName;
  $('bracket-you-hp').textContent = youHp+' HP';
  $('bracket-title').textContent = (Tourney.index===0) ? TEXTS.bracketTitleStart : TEXTS.bracketTitleNext;

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
  $('btn-again').textContent=TEXTS.tourneyRetryLabel;
  TourneyProgress.record(0, TOURNEY_YOU_HP);
  applyOppCosmetic();
  showTourneyBracket(()=>{ show('game'); startGame(); });
}
function nextTourneyOpponent(){
  Tourney.index++;
  if(Tourney.index>=TOURNEY_ROSTER.length){ Tourney.active=false; show('home'); return; }
  TourneyProgress.record(Tourney.index, Tourney._carryHp);
  applyOppCosmetic();
  showTourneyBracket(()=>{ show('game'); startGame(); });
}
// Retoma el torneo directo en el rival `idx`, con el mejor HP que se registró
// para esa ronda (cache local o de cuenta). No pisa el progreso existente.
function resumeTournamentAt(idx){
  const hp = TourneyProgress.best[idx];
  if(hp == null) return;
  Tourney.active=true; Tourney.index=idx;
  Tourney._carryHp = idx===0 ? null : hp;
  Tourney._beaten = idx-1; Tourney._duelCount=0;
  $('btn-again').textContent=TEXTS.tourneyRetryLabel;
  applyOppCosmetic();
  showTourneyBracket(()=>{ show('game'); startGame(); });
}
function updateTourneyResumeUI(){
  const has = TourneyProgress.reached().length>0;
  const btn = $('btn-tourney-resume');
  if(btn) btn.style.display = has ? 'block' : 'none';
}
function renderTourneyResumeList(){
  const wrap = $('tr-list'); wrap.innerHTML='';
  TourneyProgress.reached().forEach(idx=>{
    const r = TOURNEY_ROSTER[idx];
    if(!r) return;
    const row = document.createElement('button');
    row.type='button'; row.className='tr-row';
    row.innerHTML = `<span class="tr-row__name">${r.emoji?r.emoji+' ':''}${r.name} (${idx+1}/${TOURNEY_ROSTER.length})</span><span class="tr-row__hp">${TourneyProgress.best[idx]} HP</span>`;
    row.onclick = ()=>{ $('tourney-resume-overlay').hidden=true; readName(); App.online=false; resumeTournamentAt(idx); };
    wrap.appendChild(row);
  });
}

$('btn-howto-ok').addEventListener('click', ()=>{ $('howto').classList.remove('is-show'); startGame(); });
$('btn-tournament').addEventListener('click', ()=>{ readName(); App.online=false; startTournament(); });
$('btn-tourney-resume').addEventListener('click', ()=>{ renderTourneyResumeList(); $('tourney-resume-overlay').hidden=false; });
$('btn-tr-cancel').addEventListener('click', ()=>{ $('tourney-resume-overlay').hidden=true; });
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
  App.scoreYou=0; App.scoreOpp=0; App.roundHist=[];   // nueva serie
  $('lobby-created').style.display='flex'; $('lobby-join').style.display='none'; show('lobby');
  $('mode-select').style.display='flex'; $('btn-share').style.display='block';
  $('ot-box').style.display='none'; setModeUI(App.matchMode==='bo5'?'mode-bo5':'mode-single');
  updateSpecialToggles();
  const goBtn = $('btn-online-start'); if(goBtn) goBtn.style.display='none';
  $('wait-text').textContent=TEXTS.waitTextWaitingOpp;
  $('code-out').textContent='····';
  Net.onReady = onBothReady;
  // Si el invitado se va del lobby antes de empezar, volver a esperar (#22)
  Net.onGuestLeft = ()=>{
    App.oppName=null; App.oppUser=null;
    $('wait-text').textContent=TEXTS.waitTextOppLeft;
    const go=$('btn-online-start'); if(go) go.style.display='none';
  };
  try {
    const code=await Net.createRoom(); App.roomCode=code; $('code-out').textContent=code;
  } catch(e){
    console.error(e); toast(TEXTS.toastCreateRoomFail);
    $('code-out').textContent='––––'; return;
  }
  if(DEMO){ $('btn-demo-start').style.display='block'; $('wait-text').textContent=TEXTS.waitTextPracticeAvailable; }
}
$('btn-create').addEventListener('click', ()=>{ exitSpecialMode(); startCreateRoom(); });
$('btn-join').addEventListener('click', ()=>{ readName(); $('join-name').value=App.playerName==='Jugador'?'':App.playerName; $('lobby-created').style.display='none'; $('lobby-join').style.display='flex'; $('code-in').value=''; show('lobby'); setTimeout(()=>$('code-in').focus(),200); });

// ---- 👤 Usuario: overlay de cuenta (registro / login / sesión) ----
User.load();
Profile.load();
TourneyProgress.load();
Exp.load();
const USER_ERR_KEY = {
  'formato':     'errUserFormat',
  'pass-corta':  'errPassShort',
  'ocupado':     'errUserTaken',
  'credenciales':'errCredentials',
  'ya-logueado': 'errAlreadyLoggedIn',
  'sin-pass':    'errNoPassword',
  'sin-usuario': 'errNoUser',
  'sin-conexion':'errNoConnection',
};
function userErrText(reason){
  return TEXTS[USER_ERR_KEY[reason]] || TEXTS.errNoConnection;
}
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
// Refresca el bloque de nivel del perfil (Nivel N + barra + "X / Y EXP") desde
// el total local. Se llama al cargar EXP, al sumar y al abrir el overlay. Guarda
// por si el DOM del overlay todavía no existe.
function updateProfileLevel(){
  const info = Exp.info();
  const lbl=$('us-level-label'); if(lbl) lbl.textContent = fillText('levelLabel', {n:info.level});
  const txt=$('us-exp-text');    if(txt) txt.textContent = fillText('expProgress', {into:info.into, need:info.need});
  const fill=$('us-exp-fill');   if(fill) fill.style.width = Math.round(info.frac*100)+'%';
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
    $('user-skin').style.display = (m==='session') ? 'block' : 'none';
    primary.disabled=false;
    if(m==='register'){
      $('user-title').innerHTML=TEXTS.userTitleRegister;
      $('user-hint').textContent=TEXTS.userHintRegister;
      $('user-pass').style.display='block';
      primary.style.display='block'; primary.textContent=TEXTS.userBtnRegister;
      $('user-switch').textContent=TEXTS.userSwitchToLogin;
    } else if(m==='login'){
      $('user-title').innerHTML=TEXTS.userTitleLogin;
      $('user-hint').textContent=TEXTS.userHintLogin;
      $('user-pass').style.display='block';
      primary.style.display='block'; primary.textContent=TEXTS.userBtnLogin;
      $('user-switch').textContent=TEXTS.userSwitchToRegister;
    } else {   // session
      $('user-title').innerHTML='👤 <b>'+escHtml(User.name||'')+'</b>';
      if(User.hasPassword()){
        $('user-hint').textContent=TEXTS.userHintSession;
        $('user-pass').style.display='none';
        primary.style.display='none';
      } else {
        $('user-hint').textContent=TEXTS.userHintNoPassword;
        $('user-pass').style.display='block';
        primary.style.display='block'; primary.textContent=TEXTS.userBtnCreatePassword;
      }
      $('user-switch').textContent=TEXTS.userSwitchOther;
      loadProfileStats();
      // Nivel/EXP: pinta lo local YA y re-sincroniza con la cuenta (lo mejor gana).
      updateProfileLevel();
      Exp.loadRemote().then(()=>{ if(this.mode==='session') updateProfileLevel(); });
      // Skin: pinta lo que hay en local YA, y re-sincroniza cuando llega la
      // versión de la cuenta (Firebase gana). Si el overlay sigue en session.
      SkinPicker.sync(); SkinPicker.render();
      Profile.loadRemote().then(()=>{ if(this.mode==='session'){ SkinPicker.sync(); SkinPicker.render(); } });
      TourneyProgress.loadRemote();
    }
  },
};

// Selector de skin del perfil: bola/preview al centro, flechas a los costados.
const SkinPicker = {
  idx: 0,
  sync(){ const i = SKINS.findIndex(k=>k.id===Profile.skin); this.idx = i<0 ? 0 : i; },
  render(){
    const s = SKINS[this.idx], prev = $('skin-preview');
    prev.className = 'skin-preview is-you' + (s.sprite ? ' has-sprite' : '');
    prev.style.backgroundImage = s.sprite ? `url(${s.sprite})` : '';
    $('skin-name').textContent = (LANG==='en') ? s.nameEn : s.name;
  },
  cycle(dir){
    this.idx = (this.idx + dir + SKINS.length) % SKINS.length;
    Profile.setSkin(SKINS[this.idx].id);
    this.render();
    // Si ya estás en partida (raro desde el perfil), refleja el cambio al toque.
    if(G.running){ G.spriteYou = User.name ? Profile.sprite() : null; renderBoard(); }
  },
};
$('skin-prev').addEventListener('click', ()=>SkinPicker.cycle(-1));
$('skin-next').addEventListener('click', ()=>SkinPicker.cycle(1));
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
    toast(m==='register' ? fillText('toastUserCreated', {user:User.name}) :
          m==='login'    ? fillText('toastSessionStarted', {user:User.name}) :
                           TEXTS.toastPasswordCreated);
  } else {
    err.textContent = userErrText(res.reason);
  }
  UserUI.render();   // restaura el botón (label/estado)
});
$('user-logout').addEventListener('click', async ()=>{
  const res = await User.logout();
  if(res.ok){ $('user-overlay').hidden=true; toast(TEXTS.toastSessionClosed); }
  else $('user-err').textContent = userErrText(res.reason);
});
function setModeUI(id){
  ['mode-single','mode-bo5','mode-t4'].forEach(m=>$(m).classList.toggle('is-on', m===id));
}
$('mode-single').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='single'; setModeUI('mode-single'); updateSpecialToggles();
});
$('mode-bo5').addEventListener('click', ()=>{
  if(OT.active){ if(!OT.disableTourney()) return; }
  App.matchMode='bo5'; setModeUI('mode-bo5'); updateSpecialToggles();
});
$('mode-t4').addEventListener('click', async ()=>{
  if(OT.active) return;
  const ok=await OT.enableTourney();
  if(ok){
    setModeUI('mode-t4');
    // Paredes y Caos no están disponibles en torneo online: apagarlos y ocultar los toggles.
    if(App.wallsMode || App.chaosMode) exitSpecialMode();
    updateSpecialToggles();
  }
});
// Toggles 🧱 Paredes / 🌀 Caos del lobby (solo host, no disponibles en torneo
// online). Son mutuamente excluyentes: activar uno apaga al otro (los enter
// ya lo garantizan), y este refresco pinta ambos estados juntos.
function updateSpecialToggles(){
  const w=$('walls-toggle');
  if(w){
    w.style.display = OT.active ? 'none' : 'flex';
    w.classList.toggle('is-on', App.wallsMode);
    $('walls-state').textContent = App.wallsMode ? 'on' : 'off';
  }
  const c=$('chaos-toggle');
  if(c){
    c.style.display = OT.active ? 'none' : 'flex';
    c.classList.toggle('is-on', App.chaosMode);
    $('chaos-state').textContent = App.chaosMode ? 'on' : 'off';
  }
}
$('walls-toggle').addEventListener('click', ()=>{
  if(OT.active){ toast(TEXTS.toastWallsNotOnlineTourney); return; }
  if(App.wallsMode) exitSpecialMode(); else enterWallsMode();
  updateSpecialToggles();
});
$('chaos-toggle').addEventListener('click', ()=>{
  if(OT.active){ toast(TEXTS.toastChaosNotOnlineTourney); return; }
  if(App.chaosMode) exitSpecialMode(); else enterChaosMode();
  updateSpecialToggles();
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
  $('btn-campaign').textContent = Campaign.hasProgress() ? TEXTS.btnCampaignContinue : TEXTS.btnCampaign;
}
// Niveles = nodos tipo 'match' de la campaña ya alcanzados (superados o el
// próximo a jugar). Numerados en orden de aparición (1, 2, 3…), no por índice
// crudo de CAMPAIGN_SCRIPT (que puede tener escenas intercaladas).
function campaignLevels(){
  const maxNode = Campaign.maxNode();
  const levels=[];
  CAMPAIGN_SCRIPT.forEach((node,i)=>{ if(node.type==='match' && i<=maxNode) levels.push(i); });
  return levels;
}
function openCampaignLevelPicker(){
  const wrap=$('level-hex-grid'); wrap.innerHTML='';
  const maxNode = Campaign.maxNode();
  campaignLevels().forEach((idx,n)=>{
    const hex=document.createElement('button');
    hex.type='button'; hex.className='level-hex'+(idx===maxNode?' is-current':'');
    hex.innerHTML = `<span class="level-hex__num">${n+1}</span>`;
    hex.onclick=()=>{ $('camp-levels-overlay').hidden=true; readName(); exitSpecialMode(); App.online=false; Tourney.active=false; Campaign.enterLevel(idx); };
    wrap.appendChild(hex);
  });
  $('camp-levels-overlay').hidden=false;
}
$('camp-levels-back').addEventListener('click', ()=>{ $('camp-levels-overlay').hidden=true; });
$('btn-campaign').addEventListener('click', ()=>{
  readName(); exitSpecialMode(); App.online=false; Tourney.active=false;
  if(Campaign.hasProgress()){
    if(campaignLevels().length>1){ openCampaignLevelPicker(); return; }
    Campaign.resume(); return;
  }
  // Primera vez: menú de confirmación con el nombre del jugador
  $('camp-title').innerHTML = fillText('campaignStartConfirm', {name:escHtml(App.playerName)});
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
$('btn-camp-next').addEventListener('click', ()=>{ Campaign.continueAfterWin(); });
$('btn-offline-back').addEventListener('click', ()=>{ show('home'); });
$('btn-quick').addEventListener('click', ()=>{ readName(); Tourney.active=false; applyOppCosmetic(); App.online=false; App.oppName=TEXTS.oppNamePractice; beginGame(); });
$('btn-demo-start').addEventListener('click', ()=>{ Tourney.active=false; applyOppCosmetic(); App.online=false; App.oppName=TEXTS.oppNamePractice; beginGame(); });
$('btn-join-go').addEventListener('click', async ()=>{
  const jn=$('join-name').value.trim();
  if(jn) $('name-input').value=jn;
  readName();
  const code=$('code-in').value.trim().toUpperCase();
  if(code.length!==4){ toast(TEXTS.toastCodeLength); return; }
  if(DEMO){ App.online=false; App.oppName=TEXTS.oppNamePractice; App.roomCode=code; toast(TEXTS.toastPracticeMode); beginGame(); return; }

  App.online=true; App.isHost=false; App.roomCode=code;
  App.scoreYou=0; App.scoreOpp=0; App.roundHist=[];   // nueva serie
  const goBtn=$('btn-join-go'); goBtn.disabled=true; goBtn.textContent='Conectando…';
  Net.onReady = onBothReady;
  try {
    const res = await Net.joinRoom(code);
    if(!res.ok){
      const msg = res.reason==='no-existe' ? TEXTS.toastRoomNotFound :
                  res.reason==='llena'     ? TEXTS.toastRoomFull :
                  TEXTS.toastJoinFail;
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
    console.error(e); toast(TEXTS.toastConnectionError); goBtn.disabled=false; goBtn.textContent='Entrar';
  }
});
$('btn-lobby-back').addEventListener('click', ()=>{ if(OT.active){ OT.leaveTournament(); return; } Net.leave(); show('home'); });
$('btn-join-back').addEventListener('click', ()=>show('home'));
$('code-in').addEventListener('input', e=>{ e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
$('btn-leave').addEventListener('click', ()=>{ G.running=false; G.phase='idle'; Chat.unmount(); if(G.duel.raf) cancelAnimationFrame(G.duel.raf); if(G.duel.cpuTimer){ clearTimeout(G.duel.cpuTimer); G.duel.cpuTimer=null; } hideRpsOverlay(); clearNetDeadlines(); if(OT.active){ OT.leaveTournament(); return; } Tourney.active=false; Campaign.exitToMenu(); applyOppCosmetic(); $('btn-again').textContent=TEXTS.btnRematch; $('btn-again').style.display='block'; Net.leave(); show('home'); });
// Piedra-papel-tijera: un solo listener delegado para los 3 botones
$('rps-choices').addEventListener('click', e=>{
  const b = e.target.closest('.rps-btn');
  if(b) rpsPickLocal(+b.dataset.pick);
});
$('btn-mute').addEventListener('click', ()=>{ App.muted=!App.muted; $('btn-mute').textContent=App.muted?'♪ off':'♪ on'; });
$('btn-again').addEventListener('click', ()=>{ show('game'); startGame(); });
$('btn-home').addEventListener('click', ()=>{ Chat.unmount(); Tourney.active=false; Campaign.exitToMenu(); applyOppCosmetic(); $('btn-again').textContent=TEXTS.btnRematch; $('btn-again').style.display='block'; Net.leave(); show('home'); });

// Chat en vivo (solo online): abrir/cerrar panel y enviar mensajes.
$('chat-toggle').addEventListener('click', ()=> Chat.toggle());
$('chat-form').addEventListener('submit', e=>{ e.preventDefault(); Chat.send(); });

// #15 — Compartir invitación: arma un link con ?sala=CODIGO y lo comparte/copia
$('btn-share').addEventListener('click', async ()=>{
  const code = App.roomCode;
  if(!code || code==='····' || code==='––––'){ toast(TEXTS.toastWaitForCode); return; }
  const url = `${location.origin}${location.pathname}?sala=${code}`;
  const shareData = { title:'Rally', text:`Te invito a jugar Rally. Código: ${code}`, url };
  try {
    if(navigator.share){ await navigator.share(shareData); }
    else { await navigator.clipboard.writeText(url); toast(TEXTS.toastLinkCopiedClipboard); }
  } catch(e){
    // Cancelado o sin permiso: intentar copiar como respaldo
    try { await navigator.clipboard.writeText(url); toast(TEXTS.toastLinkCopied); }
    catch(_){ toast(fillText('toastYourLink', {url})); }
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
    toast(TEXTS.toastInviteDetected);
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
  // Toggle del pie de partida: muestra a qué tema pasás al tocarlo
  const gb = $('btn-theme-game');
  if(gb) gb.textContent = dark ? '☀' : '☾';
}
function toggleTheme(){
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('rally_theme', next); } catch(e){}
  haptic(8);
}
(function(){
  let saved = 'light';
  try { saved = localStorage.getItem('rally_theme') || 'light'; } catch(e){}
  applyTheme(saved);
  // Estado inicial: info y usuario visibles solo en el inicio; el tema flotante
  // en toda pestaña salvo la partida (mismo criterio que show()).
  const tb = $('btn-theme');
  if(tb) tb.classList.toggle('is-hidden', App.screen === 'game');
  const lb = $('btn-lang');
  if(lb) lb.classList.toggle('is-hidden', App.screen === 'game');
  const ib = $('btn-info');
  if(ib) ib.classList.toggle('is-hidden', App.screen !== 'home');
  const ub = $('btn-user');
  if(ub) ub.classList.toggle('is-hidden', App.screen !== 'home');
})();
$('btn-theme').addEventListener('click', toggleTheme);
$('btn-theme-game').addEventListener('click', toggleTheme);

// ===== 🌐 Idioma (v0.3.16) =====
// Traduce el HTML estático (botones/labels que nunca pasan por TEXTS) al
// vuelo. La versión en español se cachea del propio DOM la primera vez
// (así queda una sola fuente de verdad: el HTML) y STATIC_I18N_EN trae el
// override en inglés por id de elemento.
const STATIC_I18N_EN = {
  'btn-info': {aria:'Information'},
  'btn-theme': {aria:'Toggle theme'},
  'btn-lang': {aria:'Change language'},
  'btn-user': {aria:'Account'},
  'name-label': {text:'Your name'},
  'name-input': {placeholder:'Player'},
  'btn-create': {text:'Create room'},
  'btn-join': {text:'Join with code'},
  'divider-offline': {text:'offline'},
  'btn-offline': {text:'Play solo'},
  'info-h1': {text:'How to play'},
  'info-h2': {text:'Board elements'},
  'info-h3': {text:'The duel'},
  'info-h4': {text:'Details'},
  'btn-info-back': {text:'Back'},
  'page-credit': {html:'No © 2026<br>Made by lucio<br><a href="https://guerra-sur.web.app/" target="_blank" rel="noopener">guerra-sur.web.app</a>'},
  'offline-kicker': {text:'offline mode'},
  'offline-tag': {text:'Play offline against the machine.'},
  'btn-quick': {text:'Quick match'},
  'btn-tournament': {text:'🏆 Tournament'},
  'btn-tourney-resume': {text:'↺ Resume tournament'},
  'tr-eyebrow': {text:'Tournament'},
  'tr-title': {text:'Resume from…'},
  'tr-hint': {text:'Pick a rival you already reached. You start with the best HP you had in that round.'},
  'btn-tr-cancel': {text:'Cancel'},
  'btn-walls-label': {text:'🧱 Walls'},
  'btn-chaos-label': {text:'🌀 Chaos'},
  'btn-offline-back': {text:'Back'},
  'lobby-eyebrow-share': {text:'Share this code'},
  'lobby-hint': {text:'Your rival enters it in "Join with code" and you start.'},
  'btn-share': {text:'🔗 Share invite'},
  'mode-select-label': {text:'Game mode'},
  'mode-single-name': {text:'Single match'},
  'mode-single-desc': {text:'One duel and done.'},
  'mode-bo5-name': {text:'Best of 3'},
  'mode-bo5-desc': {text:'Series: first to 2 wins.'},
  'mode-t4-name': {text:'🏆 4-player tournament'},
  'mode-t4-desc': {text:'Up to 4 players, single elimination.'},
  'walls-toggle-label': {text:'🧱 Walls Mode'},
  'chaos-toggle-label': {text:'🌀 Chaos Mode'},
  'btn-demo-start': {text:'Start practice (vs CPU)'},
  'btn-lobby-back': {text:'Exit'},
  'join-name-label': {text:'Your name'},
  'join-name': {placeholder:'Player'},
  'lobby-eyebrow-code': {text:'Enter the code'},
  'btn-join-go': {text:'Join'},
  'btn-join-back': {text:'Back'},
  'tourney-bar-label': {text:'🏆 Tournament'},
  'btn-howto-ok': {text:'Got it'},
  'btn-leave': {text:'exit'},
  'chat-input': {placeholder:'Message…'},
  'chat-send': {aria:'Send'},
  'chat-toggle': {aria:'Chat'},
  'duel-stop': {text:'Stop'},
  'roulette-caption': {text:'who gets it?'},
  'btn-to-room': {text:'Back to room'},
  'btn-home': {text:'Back to menu'},
  'othub-eyebrow': {text:'Online tournament'},
  'btn-ot-room': {text:'Back to room'},
  'btn-ot-exit': {text:'Leave tournament'},
  'btn-spec-back': {text:'◂ Back to tournament'},
  'bracket-eyebrow': {text:'Tournament'},
  'bracket-go': {text:'Fight ▸'},
  'scene-continue': {text:'Continue ▸'},
  'user-eyebrow': {text:'Account'},
  'us-label-gamesWon': {text:'Games won'},
  'us-label-tournamentsWon': {text:'Tournaments won'},
  'us-label-achievements': {text:'🏆 Achievements'},
  'us-label-soon': {text:'Coming soon'},
  'user-skin-label': {text:'Your token'},
  'user-input': {placeholder:'username'},
  'user-pass': {placeholder:'password'},
  'user-cancel': {text:'Back'},
  'camp-eyebrow': {text:'Campaign'},
  'camp-levels-eyebrow': {text:'Campaign'},
  'camp-levels-title': {text:'Pick a level'},
  'camp-levels-back': {text:'Back'},
  'camp-yes': {text:'Start'},
  'camp-no': {text:'Back'},
  'lab-sub': {text:'Adjust the balance live. Changes apply to upcoming matches.'},
  'lab-group-actions': {text:'Quick actions'},
  'lab-force-perfect-label': {text:'Always force PERFECT (testing)'},
  'lab-spawn-ring-label': {text:'Spawn ring'},
  'lab-export': {text:'⬇ Export JSON'},
  'lab-import': {text:'⬆ Import JSON'},
  'lab-reset': {text:'Reset values'},
  'lab-back': {text:'Back'},
  'lab-json': {placeholder:'Paste JSON here to import, or export to copy it.'},
};
const TITLE_EN = 'Rally - Online Matches';
const DESC_EN = 'Rally (Rallyyy) is a casual game to play with friends or alone. Quick duels, several modes, free online matches with no signup.';
let _staticI18nEsCache = null;
function applyStaticLang(){
  if(!_staticI18nEsCache){
    _staticI18nEsCache = { title: document.title, desc: '' };
    const metaEs = document.querySelector('meta[name="description"]');
    if(metaEs) _staticI18nEsCache.desc = metaEs.getAttribute('content');
    for(const id in STATIC_I18N_EN){
      const el = $(id); if(!el) continue;
      const spec = STATIC_I18N_EN[id], cache = {};
      if(spec.text!=null) cache.text = el.textContent;
      if(spec.html!=null) cache.html = el.innerHTML;
      if(spec.placeholder!=null) cache.placeholder = el.getAttribute('placeholder');
      if(spec.aria!=null) cache.aria = el.getAttribute('aria-label');
      _staticI18nEsCache[id] = cache;
    }
  }
  const en = LANG === 'en';
  document.title = en ? TITLE_EN : _staticI18nEsCache.title;
  const meta = document.querySelector('meta[name="description"]');
  if(meta) meta.setAttribute('content', en ? DESC_EN : _staticI18nEsCache.desc);
  for(const id in STATIC_I18N_EN){
    const el = $(id); if(!el) continue;
    const use = en ? STATIC_I18N_EN[id] : _staticI18nEsCache[id];
    if(use.text!=null) el.textContent = use.text;
    if(use.html!=null) el.innerHTML = use.html;
    if(use.placeholder!=null) el.setAttribute('placeholder', use.placeholder);
    if(use.aria!=null) el.setAttribute('aria-label', use.aria);
  }
}
function applyLang(){
  refreshTexts();
  applyTextsToDom();
  applyStaticLang();
  updateCampaignBtn();
  User.updateUI();
}
function toggleLang(){
  LANG = LANG === 'es' ? 'en' : 'es';
  try { localStorage.setItem('rally_lang', LANG); } catch(e){}
  document.documentElement.setAttribute('lang', LANG);
  document.documentElement.setAttribute('data-lang', LANG);
  applyLang();
  haptic(8);
}
applyLang();
$('btn-lang').addEventListener('click', toggleLang);

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
  ['chestCount','Cantidad 🎁 inicial',0,6,1,'Modo Caos'],
  ['chestHeal','Curación del cofre',0,20,1,'Modo Caos'],
  ['bombCount','Cantidad 💣 inicial',0,6,1,'Modo Caos'],
  ['bombFuse','Mecha (turnos)',1,5,1,'Modo Caos'],
  ['bombDamage','Daño de bomba',0,30,1,'Modo Caos'],
  ['bombArea','Área (0=cruz · 1=3x3)',0,1,1,'Modo Caos'],
  ['highCount','Cantidad ⛰️ inicial',0,8,1,'Modo Caos'],
  ['highBonus','Bonus de terreno alto',0,10,1,'Modo Caos'],
  ['bootsCount','Cantidad 👟 inicial',0,4,1,'Modo Caos'],
  ['bootsRange','Alcance con botas',2,3,1,'Modo Caos'],
  ['expWinOnline','EXP victoria online',0,200,5,'Niveles'],
  ['expLoseOnline','EXP derrota online',0,200,5,'Niveles'],
  ['expWinOffline','EXP victoria offline',0,200,5,'Niveles'],
  ['expLoseOffline','EXP derrota offline',0,200,5,'Niveles'],
  ['expWinPractice','EXP victoria práctica',0,200,5,'Niveles'],
  ['expLosePractice','EXP derrota práctica',0,200,5,'Niveles'],
  ['expPerLevelBase','EXP nivel 1→2',10,500,10,'Niveles'],
  ['expPerLevelStep','EXP extra por nivel',0,300,10,'Niveles'],
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

// ===== 📝 Textos remotos (v0.2.97) =====
// Mismo patrón que applyRemoteConfig(): el panel de admin escribe overrides
// de texto en texts/ (RTDB), lectura pública, solo strings ya existentes en
// TEXTS. Se aplica al cargar (defaults, sin esperar a la red) y de nuevo si
// llega algún override, para no dejar el HTML estático en blanco mientras
// se espera a Firebase.
function applyRemoteTexts(){
  applyTextsToDom();
  if(!fbDb) return;
  fbDb.ref('texts').get().then(s=>{
    const t = s.val(); if(!t) return;
    let n=0;
    for(const k in t){
      if(typeof TEXTS_ES[k]==='string' && typeof t[k]==='string' && TEXTS_ES[k]!==t[k]){ TEXTS_ES[k]=t[k]; n++; }
    }
    if(n){ console.log('[Rally] Textos remotos aplicados:', n, 'valores'); refreshTexts(); applyTextsToDom(); }
  }).catch(()=>{});
}
applyRemoteTexts();

// ===== 📖 Campaña remota (editor /admin/, v0.3.03) =====
// El editor guarda TODA la cinta como un JSON string en campaign/script
// (lectura pública, escritura solo-admin). Si existe y es válida, REEMPLAZA
// CAMPAIGN_SCRIPT entero. Saves viejos siguen andando: índice fuera de rango
// → toBeContinued(), tipo desconocido → se saltea (ya implementado en enter()).
function applyRemoteCampaign(){
  if(!fbDb) return;
  fbDb.ref('campaign/script').get().then(s=>{
    const raw = s.val(); if(typeof raw !== 'string' || !raw) return;
    let nodes;
    try{ nodes = JSON.parse(raw); }catch(e){ console.warn('[Rally] campaign/script inválido'); return; }
    if(!Array.isArray(nodes) || !nodes.length) return;
    const valid = nodes.every(n => n && (n.type==='match' || n.type==='scene'));
    if(!valid){ console.warn('[Rally] campaign/script con nodos desconocidos'); return; }
    CAMPAIGN_SCRIPT.length = 0;
    CAMPAIGN_SCRIPT.push(...nodes);
    Campaign._remoteScript = true;   // los textos default ya no pisan el nodo 0
    console.log('[Rally] Campaña remota aplicada:', nodes.length, 'nodos');
  }).catch(()=>{});
}
applyRemoteCampaign();

// Precarga en idle (post-arranque, sin competir con la carga inicial) de los
// sprites que se pintan tarde o temprano: NPCs de campaña y la skin propia si
// hay sesión. Sin esto, la PRIMERA vez que un marker recibe su --sprite-url el
// browser recién ahí dispara la descarga y la ficha aparece unos instantes
// como bola sólida hasta que llega la imagen (mismo motivo que la precarga de
// la variante de movimiento en applyOppCosmetic, v0.3.28). Son ~30KB en total.
function preloadSpriteAssets(){
  const urls = new Set();
  Object.values(NPC_SPRITES).forEach(s=>{ if(s.idle) urls.add(s.idle); if(s.move) urls.add(s.move); });
  if(User.name && Profile.sprite()) urls.add(Profile.sprite());
  urls.forEach(u=>{ new Image().src = u; });
}
if(window.requestIdleCallback) requestIdleCallback(preloadSpriteAssets, {timeout:4000});
else setTimeout(preloadSpriteAssets, 2500);   // Safari/iOS: sin requestIdleCallback

// ===== 🎭 Personajes remotos (editor /admin/, v0.3.03) =====
// characters/roster = JSON string con un array de hasta 8 overrides
// {name, emoji, accent, trait, hp, skill} para TOURNEY_ROSTER. Solo se
// mergean campos presentes y del tipo correcto; hp/skill los consumen
// tourneyHpFor()/tourneySkillFor() con prioridad sobre la curva exponencial.
function applyRemoteCharacters(){
  if(!fbDb) return;
  fbDb.ref('characters/roster').get().then(s=>{
    const raw = s.val(); if(typeof raw !== 'string' || !raw) return;
    let arr;
    try{ arr = JSON.parse(raw); }catch(e){ console.warn('[Rally] characters/roster inválido'); return; }
    if(!Array.isArray(arr)) return;
    let n=0;
    arr.forEach((o,i)=>{
      const r = TOURNEY_ROSTER[i];
      if(!r || !o || typeof o !== 'object') return;
      if(typeof o.name==='string' && o.name.trim()){
        r.name = o.name.trim();
        // applyTextsToDom() re-aplica nombres desde TEXTS: mantener coherencia.
        // Un override explícito en texts/rosterName{i} sigue teniendo prioridad
        // (llega por applyRemoteTexts y pisa esta clave). Nombres propios: no
        // dependen del idioma, se escriben en TEXTS_ES y TEXTS por igual.
        TEXTS_ES['rosterName'+i] = r.name;
        TEXTS['rosterName'+i] = r.name;
      }
      if(typeof o.emoji==='string') r.emoji = o.emoji;
      if(typeof o.accent==='string' && o.accent) r.accent = o.accent;
      if(typeof o.trait==='string') r.trait = o.trait || undefined;
      if(typeof o.hp==='number' && o.hp>0) r.hp = o.hp;
      if(typeof o.skill==='number' && o.skill>=0 && o.skill<=1) r.skill = o.skill;
      n++;
    });
    if(n) console.log('[Rally] Personajes remotos aplicados:', n, 'rivales');
  }).catch(()=>{});
}
applyRemoteCharacters();

// Vuelca los textos estáticos (overlay howto + pantalla larga "Cómo se juega") al DOM.
function applyTextsToDom(){
  $('howto-title').textContent = TEXTS.howtoTitle;
  $('howto-text').textContent = TEXTS.howtoText;
  $('howto-legend-atk').textContent = TEXTS.howtoLegendAtk;
  $('howto-legend-def').textContent = TEXTS.howtoLegendDef;
  $('howto-legend-down').textContent = TEXTS.howtoLegendDown;
  $('howto-hint').textContent = TEXTS.howtoHint;
  $('info-intro').textContent = TEXTS.infoIntro;
  $('info-item-dmg').innerHTML = TEXTS.infoItemDmg;
  $('info-item-def').innerHTML = TEXTS.infoItemDef;
  $('info-item-trap').innerHTML = TEXTS.infoItemTrap;
  $('info-item-ring').innerHTML = TEXTS.infoItemRing;
  $('info-duel-intro').textContent = TEXTS.infoDuelIntro;
  $('info-zone-green').innerHTML = TEXTS.infoZoneGreen;
  $('info-zone-yellow').innerHTML = TEXTS.infoZoneYellow;
  $('info-zone-orange').innerHTML = TEXTS.infoZoneOrange;
  $('info-zone-red').innerHTML = TEXTS.infoZoneRed;
  $('info-perfect').innerHTML = TEXTS.infoPerfect;
  $('info-perfect-cancels').innerHTML = TEXTS.infoPerfectCancels;
  $('info-score-decay').textContent = TEXTS.infoScoreDecay;
  $('info-mercy').innerHTML = TEXTS.infoMercy;
  $('info-walls').innerHTML = TEXTS.infoWalls;
  $('info-chaos').innerHTML = TEXTS.infoChaos;
  TOURNEY_ROSTER.forEach((r,i)=>{ r.name = TEXTS['rosterName'+i] || r.name; });
  // Solo aplica a la campaña DEFAULT: con campaña remota (editor) manda el
  // nombre del editor, y además el nodo 0 puede no ser una partida (guard).
  if(!Campaign._remoteScript && CAMPAIGN_SCRIPT[0] && CAMPAIGN_SCRIPT[0].opp) CAMPAIGN_SCRIPT[0].opp.name = TEXTS.campaignOpp1Name;
  CPU_NAMES.length = 0;
  CPU_NAMES.push(...TEXTS.cpuNamesPool.split('\n').map(s=>s.trim()).filter(Boolean));
}

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
// ¿La cuenta actual es admin? Lee admins/{uid} (las reglas permiten a cada
// usuario leer SU PROPIA clave). Memoizado solo en éxito: un fallo de red no
// se cachea, así el próximo intento vuelve a preguntar.
let _isAdminCache = null;
async function isAdmin(){
  if(_isAdminCache !== null) return _isAdminCache;
  try{
    const u = await ensureAuth();
    if(!u || !fbDb) return false;
    const snap = await fbDb.ref('admins/'+u.uid).get();
    _isAdminCache = (snap.val() === true);
    return _isAdminCache;
  }catch(e){ return false; }
}
async function openLab(){
  if(!(await isAdmin())){ toast(TEXTS.toastLabAdminsOnly); return; }
  buildLab(); show('lab');
}

// ===== 🩺 Medidor de FPS / frame-time (diagnóstico, v0.3.37) =====
// Overlay chico (arriba a la izquierda) con los cuadros por segundo REALES y el
// peor frame de la ventana, para diagnosticar el "arrastre" de la aguja en móvil
// (donde este entorno de test no reproduce el raster). Se prende con ?fps=1 en la
// URL (queda en localStorage para sobrevivir la navegación del SPA) y se apaga
// con ?fps=0. Corre su PROPIO rAF: mide el framerate real de pintado del browser,
// haga lo que haga el juego. Apagado por defecto y con pointer-events:none, así
// que al jugador normal no le afecta. Clave del diagnóstico: cuenta los frames
// >50ms — son los que el clamp del duelo (Math.min(0.05,dt)) vuelve aguja
// "arrastrada", y muestra la fase (G.phase) para leer el número justo en duel-play.
(function(){
  const params=new URLSearchParams(location.search);
  if(params.get('fps')==='1'){ try{ localStorage.setItem('rally_fps','1'); }catch(e){} }
  if(params.get('fps')==='0'){ try{ localStorage.removeItem('rally_fps'); }catch(e){} }
  let on=false; try{ on = localStorage.getItem('rally_fps')==='1'; }catch(e){}
  if(!on) return;
  const hud=$('fps-hud'); if(!hud) return;
  hud.hidden=false;
  const dpr=Math.round((window.devicePixelRatio||1)*100)/100;
  let last=performance.now(), acc=0, frames=0, worst=0, over50=0;
  function tick(ts){
    const dt=ts-last; last=ts;
    // Ignorar saltos grandes (pestaña en background, throttling del SO): >500ms.
    if(dt<500){ acc+=dt; frames++; if(dt>worst) worst=dt; if(dt>50) over50++; }
    if(acc>=500 && frames){
      const fps=Math.round(frames*1000/acc);
      hud.textContent = `${fps}fps · avg ${(acc/frames).toFixed(1)} · peor ${worst.toFixed(0)}ms · >50ms:${over50} · ${(typeof G!=='undefined'&&G.phase)||'—'} · dpr${dpr}`;
      hud.classList.toggle('is-bad', fps<50);
      acc=0; frames=0; worst=0; over50=0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

// Acceso oculto (solo admins): ?lab=1 en la URL, o 5 toques en la versión
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
  App.online=false; App.oppName=TEXTS.oppNamePractice;
  enterWallsMode();
  beginGame();
});

// Modo Caos (menú offline): igual que Paredes pero con los ítems nuevos
// (cofres 🎁 y portales 🌀) en el tablero normal 7x7. Online se activa con
// el toggle 🌀 del lobby (prefijo "C~" en el board).
$('btn-chaos').addEventListener('click', ()=>{
  readName(); Tourney.active=false; applyOppCosmetic();
  App.online=false; App.oppName=TEXTS.oppNamePractice;
  enterChaosMode();
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
