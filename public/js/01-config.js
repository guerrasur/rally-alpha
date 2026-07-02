const VERSION = 'v0.2.66';
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

const App = {
  screen: 'home',
  playerName: 'Jugador',
  oppName: 'CPU',
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
