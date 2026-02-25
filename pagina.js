console.log("pagina.js carregou!");

fetch('/api/dados')
  .then(res => res.json())
  .then(data => {
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    // Painel (Resumo do Projeto)
    setText('reducao', data.reducaoCombustivel);
    setText('economia', data.economiaAnual);
    setText('eficiencia', data.eficienciaOperacional);

    // Cards (Indicadores-chave)
    setText('reducaoCard', data.reducaoCombustivel);
    setText('economiaCard', data.economiaAnual);
    setText('eficienciaCard', data.eficienciaOperacional);

    // Extras (só se você adicionou esses IDs no HTML)
    if (data.consumoAnualLitros) {
      setText('consumoAnual', `${data.consumoAnualLitros.toLocaleString('pt-BR')} L/ano`);
    }
    if (data.litrosEconomizados) {
      setText('litrosEconomizados', `${data.litrosEconomizados.toLocaleString('pt-BR')} L/ano`);
    }
    if (data.co2EvitadoTon) {
      setText('co2Evitado', `${data.co2EvitadoTon.toLocaleString('pt-BR')} t/ano`);
    }
  })
  .catch(err => console.error('Erro ao carregar dados:', err));