// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ MUDANÇA MÍNIMA: CORS liberado pro Render / domínio
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// (Opcional) OpenAI instalado — só usaremos se você decidir chamar API depois
// Não é necessário pra IA “simulada” funcionar.
let openai = null;
try {
  const OpenAI = require("openai");
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (_) {
  // ok: sem openai
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ✅ abre solucao.html na raiz /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "solucao.html"));
});

// ✅ MUDANÇA MÍNIMA: rota health (Render)
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ===== CONFIG =====
const CONFIG = {
  // Macro/Anual (para os cards anuais que você já tinha)
  consumoAnualLitros: 15_120_000,
  metaReducao: 0.15,
  dieselPrecoLitro: 6.0,
  co2KgPorLitro: 2.68,

  // ✅ Modelo AO VIVO da FROTA (simulação)
  // consumoBaseLph: base de consumo por caminhão em L/h (ajuste como quiser)
  consumoBaseLph: 38, // L/h por caminhão em situação “padrão”
  consumoPadraoMult: 1.0,
  consumoEcoMult: 0.90, // rota econômica reduz ~10% (ajuste conforme narrativa)
};

// ===== ESTADO =====
const state = {
  updatedAt: new Date().toISOString(),

  // Macro (anual)
  consumoAnualLitros: CONFIG.consumoAnualLitros,
  metaReducao: CONFIG.metaReducao,
  litrosEconomizados: 0,
  economiaReais: 0,
  co2EvitadoTon: 0,

  // Operação (cenário da mina)
  operacao: {
    rotaMode: "economica", // economica | padrao | rapida
    velocidadeAlvo: 34, // km/h
    etaMin: 18,
    clima: "seco", // seco | chuva
    solo: "regular", // regular | lama
    inclinacao: 6, // %
    cargaTon: 28, // t
    turno: "A",
    ociosidadeMin: 11,
  },

  // Frota
  veiculos: [
    { id: "CAM-01", nome: "Caminhão 01", score: 88, status: "online", ociosidadeMin: 6, previsao: -9, rpm: 1500, paradas: 1 },
    { id: "CAM-07", nome: "Caminhão 07", score: 72, status: "online", ociosidadeMin: 11, previsao: -6, rpm: 1650, paradas: 2 },
    { id: "CAM-12", nome: "Caminhão 12", score: 91, status: "online", ociosidadeMin: 3, previsao: -12, rpm: 1450, paradas: 0 },
    { id: "CAM-18", nome: "Caminhão 18", score: 79, status: "online", ociosidadeMin: 8, previsao: -7, rpm: 1580, paradas: 1 },
  ],

  // ✅ KPIs AO VIVO DA FROTA (acumulados)
  frotaLive: {
    ativa: true,
    consumoPadraoL: 0,   // litros acumulados se fosse padrão
    consumoRealL: 0,     // litros acumulados com estratégia atual
    economiaL: 0,        // litros economizados acumulados
    economiaPct: 0,      // % economizando vs padrão
    economiaReais: 0,    // ✅ (melhor que "economiaR$")
    consumoAtualLph: 0,  // L/h somado da frota (instante)
    iniciouEm: Date.now(),
  },

  // Alertas + IA
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
    piorVeiculo: "",
    melhorVeiculo: "",
    scoreMedio: 0,
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

// ===== MODELO DE CONSUMO (FROTA AO VIVO) =====
function estimarFatorConsumoVeiculo({ inclinacao, clima, solo, cargaTon, velocidadeAlvo, ociosidadeMin }) {
  let fator = 1.0;

  fator += clamp(inclinacao, 0, 12) * 0.012; // subida pesa
  fator += clamp(cargaTon, 0, 40) * 0.006;  // carga
  fator += (clima === "chuva") ? 0.05 : 0.0;
  fator += (solo === "lama") ? 0.07 : 0.0;
  fator += clamp(velocidadeAlvo - 30, -10, 20) * 0.008; // velocidade fora da faixa
  fator += clamp(ociosidadeMin, 0, 20) * 0.01; // ociosidade

  return Number(fator.toFixed(2));
}

function consumoLphPorVeiculo(v) {
  const fator = estimarFatorConsumoVeiculo({
    inclinacao: state.operacao.inclinacao,
    clima: state.operacao.clima,
    solo: state.operacao.solo,
    cargaTon: state.operacao.cargaTon,
    velocidadeAlvo: state.operacao.velocidadeAlvo,
    ociosidadeMin: v.ociosidadeMin,
  });

  const multRota =
    state.operacao.rotaMode === "economica"
      ? CONFIG.consumoEcoMult
      : CONFIG.consumoPadraoMult;

  const realLph = CONFIG.consumoBaseLph * fator * multRota;
  const padraoLph = CONFIG.consumoBaseLph * fator * CONFIG.consumoPadraoMult;

  return { fator, realLph, padraoLph };
}

function atualizarFrotaLive(dtSeg) {
  if (!state.frotaLive?.ativa) return;

  let realTotalLph = 0;
  let padraoTotalLph = 0;

  for (const v of state.veiculos) {
    const { realLph, padraoLph } = consumoLphPorVeiculo(v);
    realTotalLph += realLph;
    padraoTotalLph += padraoLph;
  }

  const realLitros = realTotalLph * (dtSeg / 3600);
  const padraoLitros = padraoTotalLph * (dtSeg / 3600);

  state.frotaLive.consumoRealL += realLitros;
  state.frotaLive.consumoPadraoL += padraoLitros;

  const economiaL = Math.max(0, state.frotaLive.consumoPadraoL - state.frotaLive.consumoRealL);
  const economiaPct = (state.frotaLive.consumoPadraoL > 0)
    ? (economiaL / state.frotaLive.consumoPadraoL) * 100
    : 0;

  state.frotaLive.economiaL = economiaL;
  state.frotaLive.economiaPct = Number(economiaPct.toFixed(1));

  // ✅ MUDANÇA MÍNIMA: nome simples (sem "$" no campo)
  state.frotaLive.economiaReais = economiaL * CONFIG.dieselPrecoLitro;

  state.frotaLive.consumoAtualLph = Number(realTotalLph.toFixed(1));
}

// ===== IA (FROTA - “empresa”) =====
function scoreToGrade(score){
  if(score >= 92) return "A+";
  if(score >= 88) return "A";
  if(score >= 82) return "A-";
  if(score >= 76) return "B+";
  if(score >= 70) return "B";
  if(score >= 64) return "B-";
  return "C";
}

function gerarIA() {
  const sortedAsc = [...state.veiculos].sort((a,b)=>a.score-b.score);
  const sortedDesc = [...state.veiculos].sort((a,b)=>b.score-a.score);

  const vPior = sortedAsc[0];
  const vPior2 = sortedAsc[1] || sortedAsc[0];
  const vMelhor = sortedDesc[0];

  const fatores = state.veiculos.map(v => consumoLphPorVeiculo(v).fator);
  const fatorMedio = Number((fatores.reduce((s,x)=>s+x,0) / fatores.length).toFixed(2));

  const scoreMedio = Math.round(state.veiculos.reduce((s,v)=>s+v.score,0) / state.veiculos.length);
  const grade = scoreToGrade(scoreMedio);

  const ociosidadeTotalMin = state.veiculos.reduce((s,v)=>s+v.ociosidadeMin,0);
  const perdaOciosidadeL = (ociosidadeTotalMin / 60) * 3.2;

  const recomendacoes = [];
  const acaoAutomatica = [];
  const motivos = [];

  if (ociosidadeTotalMin >= 20) {
    recomendacoes.push(`Reduzir ociosidade da frota (total ${ociosidadeTotalMin} min).`);
    recomendacoes.push(`Prioridade: ${vPior.id} (${vPior.ociosidadeMin} min) e ${vPior2.id} (${vPior2.ociosidadeMin} min).`);
    motivos.push(`Ociosidade estimada gera ~${perdaOciosidadeL.toFixed(1)} L perdidos no ciclo atual.`);
    acaoAutomatica.push("Enviar alerta de desligamento + checklist de parada para os 2 piores.");
  }

  if (vPior.score <= 75) {
    recomendacoes.push(`Padronizar condução econômica: foco em ${vPior.id} (score ${vPior.score}%).`);
    motivos.push("Score baixo indica aceleração/frenagem fora do ideal, aumentando consumo.");
    acaoAutomatica.push("Aplicar perfil de velocidade segura para o veículo com pior score.");
  }

  if (state.operacao.clima === "chuva" || state.operacao.solo === "lama") {
    recomendacoes.push("Aplicar restrição de risco: evitar trechos com solo ruim/chuva.");
    motivos.push("Condição adversa aumenta consumo e risco de patinagem/parada.");
    acaoAutomatica.push("Forçar modo de rota econômica com restrição de risco.");
    state.operacao.rotaMode = "economica";
  }

  let novaVel = state.operacao.velocidadeAlvo;

  if (fatorMedio > 1.25) {
    novaVel = clamp(novaVel - 4, 22, 40);
    acaoAutomatica.push(`Reduzir velocidade alvo da frota para ${novaVel} km/h (estabiliza consumo).`);
    motivos.push("Modelo preditivo indica consumo elevado: reduzir velocidade melhora estabilidade e economia.");
  } else if (fatorMedio < 1.10 && scoreMedio > 88) {
    novaVel = clamp(novaVel + 1, 22, 40);
  }

  state.operacao.velocidadeAlvo = novaVel;

  const alertas = [];
  if (Date.now() > state.flags.silenciarAte) {
    if (vPior.ociosidadeMin >= 10) alertas.push({ nivel: "warn", texto: `${vPior.id}: ociosidade ${vPior.ociosidadeMin} min` });
    if (vPior.score <= 75) alertas.push({ nivel: "warn", texto: `${vPior.id}: eficiência baixa (${vPior.score}%)` });
    if (state.operacao.clima === "chuva") alertas.push({ nivel: "warn", texto: `Clima: chuva — aumentar cautela e rota econômica` });
    if (state.operacao.solo === "lama") alertas.push({ nivel: "warn", texto: `Solo: lama — risco de patinagem e maior consumo` });
  } else {
    alertas.push({ nivel: "ok", texto: "Alertas silenciados temporariamente (15 min)" });
  }

  alertas.push({ nivel: "ok", texto: `Melhor desempenho: ${vMelhor.id} (${vMelhor.score}%)` });
  alertas.push({ nivel: "ok", texto: `Frota: score médio ${scoreMedio}% • modo ${state.operacao.rotaMode} • vel ${state.operacao.velocidadeAlvo} km/h` });

  state.alertas = alertas;

  state.ai = {
    score: grade,
    recomendacoes: recomendacoes.slice(0, 4),
    acaoAutomatica: acaoAutomatica.slice(0, 4),
    motivos: motivos.slice(0, 4),
    proximoPasso: recomendacoes[0]
      ? "Executar ações sugeridas e reavaliar em 10 min"
      : "Operação está estável; manter padrão e monitorar",
    modoRota: state.operacao.rotaMode,
    velocidadeAlvo: state.operacao.velocidadeAlvo,
    fatorConsumo: fatorMedio,
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

  if (Math.random() < 0.18) state.operacao.clima = pick(["seco", "chuva"]);
  if (Math.random() < 0.15) state.operacao.solo = pick(["regular", "lama"]);
  state.operacao.inclinacao = clamp(jitter(state.operacao.inclinacao, 0.20), 0, 12);
  state.operacao.cargaTon = clamp(jitter(state.operacao.cargaTon, 0.10), 10, 40);

  state.veiculos = state.veiculos.map(v => {
    const score = clamp(jitter(v.score, 0.06), 60, 98);
    const ociosidadeMin = clamp(jitter(v.ociosidadeMin, 0.25), 0, 30);
    const previsao = clamp(jitter(v.previsao, 0.20), -20, -1);
    const rpm = clamp(jitter(v.rpm, 0.05), 1100, 2100);
    const paradas = clamp(jitter(v.paradas, 0.40), 0, 6);
    return { ...v, score, ociosidadeMin, previsao, rpm, paradas };
  });

  gerarIA();
  atualizarFrotaLive(dtSeg);

  state.updatedAt = new Date().toISOString();

  io.emit("telemetria:update", {
    updatedAt: state.updatedAt,
    operacao: state.operacao,
    veiculos: state.veiculos,
    alertas: state.alertas,
    ai: state.ai,
    frotaLive: state.frotaLive,
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

app.get("/api/frota", (req, res) => {
  res.json({
    ...state.frotaLive,
    updatedAt: state.updatedAt,
    clima: state.operacao.clima,
    solo: state.operacao.solo,
    rotaMode: state.operacao.rotaMode,
    velAlvo: state.operacao.velocidadeAlvo,
  });
});

app.get("/api/ai", (req, res) => {
  res.json(state.ai);
});

// ===== AÇÕES (botões) =====
app.post("/api/acao/recalcular-rota", (req, res) => {
  state.operacao.rotaMode = "economica";
  state.operacao.etaMin = clamp(state.operacao.etaMin - 1, 8, 40);

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
    veiculos: state.veiculos,
    alertas: state.alertas,
    ai: state.ai,
    frotaLive: state.frotaLive,
  });
});

// ✅ Render usa PORT por variável de ambiente
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));