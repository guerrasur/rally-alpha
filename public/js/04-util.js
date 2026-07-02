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

