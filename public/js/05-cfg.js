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

