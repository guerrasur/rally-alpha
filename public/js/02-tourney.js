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
