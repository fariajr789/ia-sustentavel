// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ✅ abre solucao.html na raiz /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "solucao.html"));
});

// ===== CONFIG =====
const CONFIG = {
  consumoAnualLitros: 15_120_000,
  metaReducao: 0.15,
  dieselPrecoLitro: 6.0,
  co2KgPorLitro: 2.68,

  // ✅ parâmetros de simulação do caminhão
  consumoBaseLph: 28,         // L/h em condição “normal”
  consumoPadraoMult: 1.00,    // rota padrão
  consumoEcoMult: 0.88,       // rota econômica (12% melhor)
  kmPorHoraBase: 34,          // “vel média” base (antes de ajustes)
};

// ===== ESTADO =====
const state = {
  updatedAt: new Date().toISOString(),

  consumoAnualLitros: CONFIG.consumoAnualLitros,
  metaReducao: CONFIG.metaReducao,

  litrosEconomizados: 0,
  economiaReais: 0,
  co2EvitadoTon: 0,

  operacao: {
    rotaMode: "economica", // economica | padrao | rapida
    velocidadeAlvo: 34,    // km/h
    etaMin: 18,
    clima: "seco",         // seco | chuva
    solo: "regular",       // regular | lama
    inclinacao: 6,         // %
    cargaTon: 28,          // t
    turno: "A",
    ociosidadeMin: 11,
  },

  // ✅ “Rota atual” (KPIs do caminhão em andamento)
  rotaAtual: {
    ativa: true,
    distanciaKm: 18,          // distância da viagem simulada
    kmRestante: 18,
    consumoPadraoL: 0,
    consumoRealL: 0,
    economiaL: 0,
    economiaPct: 0,
    economiaR$: 0,
    consumoAtualLph: 0,
    iniciouEm: Date.now(),
  },

  veiculos: [
    { id: "CAM-01", nome: "Caminhão 01", score: 88, status: "online", ociosidadeMin: 6, previsao: -9, rpm: 1500, paradas: 1 },
    { id: "CAM-07", nome: "Caminhão 07", score: 72, status: "online", ociosidadeMin: 11, previsao: -6, rpm: 1650, paradas: 2 },
    { id: "CAM-12", nome: "Caminhão 12", score: 91, status: "online", ociosidadeMin: 3, previsao: -12, rpm: 1450, paradas: 0 },
    { id: "CAM-18", nome: "Caminhão 18", score: 79, status: "online", ociosidadeMin: 8, previsao: -7, rpm: 1580, paradas: 1 },
  ],

  alertas: [],
  ai: {
    score: "A-",
    recomendacoes: [],
    acaoAutomatica: [],
    motivos: [],
    proximoPasso: "",
    modoRota: "economica",
    velocidadeAlvo: 34,
    fatorConsumo: 1.0,
    scoreMedio: 0,
    piorVeiculo: "",
    melhorVeiculo: "",
  },

  flags: {
    silenciarAte: 0,
  },
};

function recalcularDerivados() {
  state.litrosEconomizados = Math.round(state.consumoAnualLitros * state.metaReducao);
  state.economiaReais = Math.round(state.litrosEconomizados * CONFIG.dieselPrecoLitro);
  state.co2EvitadoTon = Math.round((state.litrosEconomizados * CONFIG.co2KgPorLitro) / 1000);
  state.updatedAt = new Date().toISOString();
}
recalcularDerivados();

// ===== util =====
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function jitter(n, pct = 0.03) {
  const delta = n * pct * (Math.random() - 0.5);
  return Math.round(n + delta);
}
function pick(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

function scoreToGrade(score){
  if(score >= 92) return "A+";
  if(score >= 88) return "A";
  if(score >= 82) return "A-";
  if(score >= 76) return "B+";
  if(score >= 70) return "B";
  if(score >= 64) return "B-";
  return "C";
}

// ===== Modelo de consumo (leve, mas “realista”) =====
function estimarFatorConsumo({ inclinacao, clima, solo, cargaTon, velocidadeAlvo, ociosidadeMin }) {
  let fator = 1.0;
  fator += clamp(inclinacao, 0, 12) * 0.012;
  fator += clamp(cargaTon, 0, 40) * 0.006;
  fator += (clima === "chuva") ? 0.05 : 0.0;
  fator += (solo === "lama") ? 0.07 : 0.0;
  fator += clamp(velocidadeAlvo - 30, -10, 20) * 0.008;
  fator += clamp(ociosidadeMin, 0, 20) * 0.01;
  return Number(fator.toFixed(2));
}

function calcularConsumoLph() {
  const fator = estimarFatorConsumo(state.operacao);
  const multRota = (state.operacao.rotaMode === "economica")
    ? CONFIG.consumoEcoMult
    : CONFIG.consumoPadraoMult;

  const consumoAtualLph = CONFIG.consumoBaseLph * fator * multRota;
  return { fator, consumoAtualLph };
}

// ===== Atualiza rota atual acumulando litros e economia =====
function atualizarRotaAtual(dtSeg) {
  if (!state.rotaAtual.ativa) return;

  const { fator, consumoAtualLph } = calcularConsumoLph();

  // “padrão” = consumo base * fator * (rota padrão)
  const consumoPadraoLph = CONFIG.consumoBaseLph * fator * CONFIG.consumoPadraoMult;

  // litros neste intervalo
  const litrosReal = consumoAtualLph * (dtSeg / 3600);
  const litrosPadrao = consumoPadraoLph * (dtSeg / 3600);

  state.rotaAtual.consumoRealL += litrosReal;
  state.rotaAtual.consumoPadraoL += litrosPadrao;

  // km rodados (aprox): velocidade alvo (km/h) * tempo
  const kmRodados = (state.operacao.velocidadeAlvo * (dtSeg / 3600));
  state.rotaAtual.kmRestante = Math.max(0, state.rotaAtual.kmRestante - kmRodados);

  // ETA (min)
  state.operacao.etaMin = Math.max(1, Math.round((state.rotaAtual.kmRestante / Math.max(1, state.operacao.velocidadeAlvo)) * 60));

  // economia
  const economiaL = Math.max(0, state.rotaAtual.consumoPadraoL - state.rotaAtual.consumoRealL);
  const economiaPct = (state.rotaAtual.consumoPadraoL > 0)
    ? (economiaL / state.rotaAtual.consumoPadraoL) * 100
    : 0;

  state.rotaAtual.economiaL = economiaL;
  state.rotaAtual.economiaPct = Number(economiaPct.toFixed(1));
  state.rotaAtual["economiaR$"] = economiaL * CONFIG.dieselPrecoLitro;
  state.rotaAtual.consumoAtualLph = Number(consumoAtualLph.toFixed(1));

  // fim da rota -> reinicia automaticamente
  if (state.rotaAtual.kmRestante <= 0) {
    state.rotaAtual.distanciaKm = pick([12, 18, 24, 30]);
    state.rotaAtual.kmRestante = state.rotaAtual.distanciaKm;
    state.rotaAtual.consumoPadraoL = 0;
    state.rotaAtual.consumoRealL = 0;
    state.rotaAtual.economiaL = 0;
    state.rotaAtual.economiaPct = 0;
    state.rotaAtual["economiaR$"] = 0;
    state.rotaAtual.iniciouEm = Date.now();
  }
}

// ===== IA (textos melhores) =====
function gerarIA() {
  const vPior = [...state.veiculos].sort((a,b) => a.score - b.score)[0];
  const vMelhor = [...state.veiculos].sort((a,b) => b.score - a.score)[0];

  const fator = estimarFatorConsumo(state.operacao);

  const recomendacoes = [];
  const acaoAutomatica = [];
  const motivos = [];

  // Regras “de empresa”
  if (vPior.ociosidadeMin >= 10) {
    recomendacoes.push(`Reduzir ociosidade do ${vPior.id} de ${vPior.ociosidadeMin} min para < 5 min (prioridade alta)`);
    acaoAutomatica.push("Acionar alerta no multimídia: 'Desligar motor em parada > 3 min'");
    motivos.push("Ociosidade é consumo puro sem produzir; é a ação mais rápida para economizar.");
  }

  if (vPior.score <= 75) {
    recomendacoes.push(`Padronizar condução econômica no ${vPior.id}: foco em aceleração suave e frenagem antecipada`);
    acaoAutomatica.push("Ativar modo 'velocidade segura' + lembrete de condução estável");
    motivos.push("Score baixo indica padrão fora do ideal (picos de aceleração/frenagem aumentam consumo).");
  }

  if (state.operacao.clima === "chuva" || state.operacao.solo === "lama") {
    recomendacoes.push("Evitar trechos críticos e manter rota econômica até normalizar condições");
    acaoAutomatica.push("Forçar rota econômica + restrição de risco (chuva/solo ruim)");
    motivos.push("Condição adversa aumenta arrasto, patinagem e exige mais torque (consumo sobe).");
    state.operacao.rotaMode = "economica";
  }

  // decisão de velocidade (com justificativa)
  let novaVel = state.operacao.velocidadeAlvo;

  if (fator >= 1.25) {
    const alvo = clamp(novaVel - 4, 22, 40);
    if (alvo !== novaVel) {
      novaVel = alvo;
      acaoAutomatica.push(`Ajustar velocidade alvo para ${novaVel} km/h (estabilizar consumo)`);
      motivos.push(`Fator de consumo ${fator} indica tendência de gasto elevado; reduzir velocidade estabiliza.`);
    }
  } else if (fator <= 1.10 && vMelhor.score >= 90) {
    novaVel = clamp(novaVel + 1, 22, 40);
  }

  state.operacao.velocidadeAlvo = novaVel;

  // alertas
  const alertas = [];
  if (Date.now() > state.flags.silenciarAte) {
    if (vPior.ociosidadeMin >= 10) alertas.push({ nivel: "warn", texto: `${vPior.id}: ociosidade ${vPior.ociosidadeMin} min` });
    if (vPior.score <= 75) alertas.push({ nivel: "warn", texto: `${vPior.id}: eficiência baixa (${vPior.score}%)` });
  } else {
    alertas.push({ nivel: "ok", texto: "Alertas silenciados temporariamente (15 min)" });
  }
  alertas.push({ nivel: "ok", texto: `Melhor desempenho: ${vMelhor.id} (${vMelhor.score}%)` });
  alertas.push({ nivel: "ok", texto: `IA: modo ${state.operacao.rotaMode} • vel ${state.operacao.velocidadeAlvo} km/h` });

  const scoreMedio = Math.round(state.veiculos.reduce((s,v)=>s+v.score,0) / state.veiculos.length);
  const grade = scoreToGrade(scoreMedio);

  state.alertas = alertas;

  state.ai = {
    score: grade,
    recomendacoes: recomendacoes.slice(0, 4),
    acaoAutomatica: acaoAutomatica.slice(0, 4),
    motivos: motivos.slice(0, 4),
    proximoPasso: recomendacoes[0]
      ? "Executar a 1ª recomendação e reavaliar em 10 min (tendência de consumo)."
      : "Operação está estável; manter padrão e monitorar.",
    modoRota: state.operacao.rotaMode,
    velocidadeAlvo: state.operacao.velocidadeAlvo,
    fatorConsumo: fator,
    piorVeiculo: vPior.id,
    melhorVeiculo: vMelhor.id,
    scoreMedio,
  };
}

// ===== SIMULADOR AO VIVO =====
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dtSeg = Math.max(1, (now - lastTick) / 1000);
  lastTick = now;

  // varia cenário
  if (Math.random() < 0.18) state.operacao.clima = pick(["seco", "chuva"]);
  if (Math.random() < 0.15) state.operacao.solo = pick(["regular", "lama"]);
  state.operacao.inclinacao = clamp(jitter(state.operacao.inclinacao, 0.20), 0, 12);
  state.operacao.cargaTon = clamp(jitter(state.operacao.cargaTon, 0.10), 10, 40);

  // veículos variam
  state.veiculos = state.veiculos.map(v => {
    const score = clamp(jitter(v.score, 0.06), 60, 98);
    const ociosidadeMin = clamp(jitter(v.ociosidadeMin, 0.25), 0, 30);
    const previsao = clamp(jitter(v.previsao, 0.20), -20, -1);
    const rpm = clamp(jitter(v.rpm, 0.05), 1100, 2100);
    const paradas = clamp(jitter(v.paradas, 0.40), 0, 6);
    return { ...v, score, ociosidadeMin, previsao, rpm, paradas };
  });

  // IA decide
  gerarIA();

  // atualiza KPIs da rota atual
  atualizarRotaAtual(dtSeg);

  state.updatedAt = new Date().toISOString();

  // emite
  io.emit("telemetria:update", {
    updatedAt: state.updatedAt,
    operacao: state.operacao,
    rotaAtual: state.rotaAtual,
    veiculos: state.veiculos,
    alertas: state.alertas,
    ai: state.ai,
  });
}, 2500);

// ===== API =====
app.get("/api/dados", (req, res) => {
  recalcularDerivados();
  res.json({
    consumoAnualLitros: state.consumoAnualLitros,
    reducaoCombustivel: `${Math.round(state.metaReducao * 100)}%`,
    litrosEconomizados: state.litrosEconomizados,
    economiaAnual: state.economiaReais.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
    co2EvitadoTon: state.co2EvitadoTon,
    updatedAt: state.updatedAt,
  });
});

app.get("/api/rota", (req, res) => {
  res.json(state.rotaAtual);
});

app.post("/api/acao/recalcular-rota", (req, res) => {
  state.operacao.rotaMode = "economica";
  state.veiculos = state.veiculos.map(v => ({
    ...v,
    previsao: clamp(v.previsao - 1, -20, -1),
    score: clamp(v.score + 2, 60, 98),
  }));
  gerarIA();
  res.json({ ok: true, rotaMode: state.operacao.rotaMode });
});

app.post("/api/acao/silenciar", (req, res) => {
  state.flags.silenciarAte = Date.now() + 15 * 60 * 1000;
  gerarIA();
  res.json({ ok: true, ate: state.flags.silenciarAte });
});

app.post("/api/acao/confirmar-ajuste", (req, res) => {
  state.veiculos = state.veiculos.map(v => ({
    ...v,
    ociosidadeMin: clamp(v.ociosidadeMin - 3, 0, 30),
    rpm: clamp(v.rpm - 80, 1100, 2100),
    score: clamp(v.score + 1, 60, 98),
  }));
  gerarIA();
  res.json({ ok: true });
});

// Socket
io.on("connection", (socket) => {
  socket.emit("telemetria:update", {
    updatedAt: state.updatedAt,
    operacao: state.operacao,
    rotaAtual: state.rotaAtual,
    veiculos: state.veiculos,
    alertas: state.alertas,
    ai: state.ai,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor rodando em http://localhost:${PORT}`));