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

