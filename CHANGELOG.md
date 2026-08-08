# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.2.0] — 2026-08-08

Revisão de precisão das métricas e redesenho do painel.

### Corrigido

- **Sessões colapsavam em uma só.** O transcript grava `sessionId`, mas o código
  lia `session_id` e caía sempre no nome do diretório do projeto. Todas as
  sessões de um mesmo projeto viravam uma. Passou de 10 para 111 sessões
  distintas na base local.
- **Cache de 1 hora cobrado como se fosse de 5 minutos.** O campo
  `usage.cache_creation` separa `ephemeral_5m_input_tokens` de
  `ephemeral_1h_input_tokens`, e as taxas são diferentes (1,25× e 2,00× o preço
  de input). Na base local o cache de 1h é 87M tokens contra 4,8M de 5 min — a
  fatia maior estava subestimada.
- **Preço de Opus fora da faixa da versão.** `opus-4-8` e `opus-5` eram cobrados
  a 15/75 (tabela do Opus 4.1), quando a faixa a partir do Opus 4.5 é 5/25. O
  custo desses modelos saía ~3× maior. A tabela passou a ser por versão, com as
  taxas de cache derivadas do preço de input.
- **Entradas sem chamada de API entravam na contagem.** Respostas `<synthetic>`
  e as marcadas com `isApiErrorMessage` somavam chamadas sem somar token
  (45 entradas na base local).
- **Janela de limite era de 5h, é de 4h.** A duração virou `BLOCK_HOURS` em
  `src/watcher.js` e viaja no snapshot, então cálculo e rótulos saem da mesma
  constante.
- **Bloco não era ancorado na hora cheia.** O servidor conta a janela a partir da
  hora cheia da primeira chamada; um bloco novo abre quando o anterior completa a
  duração ou quando esse mesmo tempo passa sem chamada.
- **Dia em UTC no alerts contra dia local no watcher.** O alerta de gasto diário
  rearmava no meio da tarde em vez da virada do dia. As chaves de tempo foram
  para `src/time.js`, compartilhadas pelos dois.
- **Taxa diluída pelo minuto corrente.** A média passou a usar os 5 minutos
  fechados; o minuto pela metade ficava puxando o número para baixo a cada
  segundo.
- **Semana com fronteira aproximada.** A janela virou 7 dias corridos exatos, com
  o dia de hoje inteiro.

### Adicionado

- **Porcentagem da cota do bloco, como no `/usage`.** O limite do plano vem do
  servidor e não existe em arquivo local — o campo `rateLimits` dos transcripts
  vem sempre nulo nas 28 ocorrências da base. A porcentagem é deduzida por
  calibração: informe uma vez o número que o `/usage` mostra e a cota fica salva.
- **Cota medida em custo, não em tokens.** A cota do plano é ponderada por
  modelo, e o custo estimado já embute esse peso. Os mesmos 5M de tokens entram
  como 7,5% em Opus 5, 4,5% em Sonnet 5 e 1,5% em Haiku 4.5 — trocar de modelo se
  corrige sozinho, sem recalibrar.
- **Alerta de escopo `blockCost`**, rearmado a cada bloco novo.
- **Ritmo e projeção do bloco** — tokens/min e onde o bloco fecha mantendo o
  ritmo atual.
- **Deduplicação estável entre cópias de transcript**, por `message.id` +
  `requestId`. A mesma chamada reaparece quando uma sessão é retomada e o
  arquivo é copiado.

### Adicionado — identidade

- **Ícone do app** em `assets/`: mostrador circular aberto embaixo, preenchido
  em azul `#58A6FF` sobre trilho escuro, com barras ascendentes ao centro e a
  ponta da maior em verde `#3FB950`. A forma é a mesma leitura do painel — cota
  parcial de um bloco, com consumo subindo.
  Gerado em `.ico` multi-tamanho (16 a 256) para o Windows e PNG de 16 a 512;
  usado na janela, na barra de tarefas, nas notificações e na barra de título do
  próprio painel, onde o ponto de atividade virou um badge no canto do ícone.
- **README com cabeçalho de marca**: ícone centralizado, título, resumo e
  atalhos para o changelog, a calibração e a seção de custos. O ladrilho é
  escuro com os cantos transparentes, então funciona nos dois temas do GitHub.
- **Screenshot do painel** em `assets/screenshot.png`, capturado em 2x da janela
  real rodando com o mesmo watcher, config e alerts do app. O script de captura
  ficou fora do projeto de propósito — o app não precisa carregar código de
  screenshot.

### Alterado — interface

- Bloco de 4h virou o destaque do topo, no lugar dos quatro cartões iguais.
- Ícones SVG (Lucide) no lugar de emoji, com `aria-label` e foco visível.
- Rolagem única: acabou o scroll aninhado dentro da lista, e as abas fixam no
  topo.
- Gráfico com gradiente, linhas de escala, eixo de tempo e leitura por minuto no
  hover.
- Tokens de espaçamento e cor, números tabulares em toda coluna numérica,
  `prefers-reduced-motion` respeitado.
- CSP bloqueando qualquer carregamento externo.

### Desempenho

- Índice de deduplicação rotaciona em duas gerações em vez de crescer sem limite.
- Minutos com mais de 30 dias são podados.
- A ordem das chaves de minuto só é recalculada quando muda, não a cada snapshot
  (antes: uma ordenação completa a cada 1,5s).

### Validação

Tabela de preços conferida contra o `costUSD` que o próprio Claude Code grava em
`~/.claude.json` (campo `lastModelUsage`):

| Modelo                    | costUSD oficial | Calculado aqui | Erro  |
| ------------------------- | --------------- | -------------- | ----- |
| claude-opus-5[1m]         | 0.480930        | 0.480930       | 0.00% |
| claude-opus-5             | 0.943803        | 0.943803       | 0.00% |
| claude-opus-5             | 3.476579        | 3.476579       | 0.00% |
| claude-haiku-4-5-20251001 | 0.229565        | 0.229565       | 0.00% |
| claude-haiku-4-5-20251001 | 0.058343        | 0.058343       | 0.00% |
| claude-haiku-4-5-20251001 | 0.039076        | 0.039076       | 0.00% |
| claude-haiku-4-5-20251001 | 0.000589        | 0.000589       | 0.00% |

Confirma os preços por modelo (Opus 5 em 5/25, Haiku 4.5 em 1/5) e os
multiplicadores de cache (write 1h = 2,00× input, write 5m = 1,25× input,
read = 0,10× input). O sufixo `[1m]` bateu com as mesmas taxas do modelo base.

### Migração

Quem calibrou na versão anterior precisa refazer uma vez: `blockTokenLimit` (em
tokens) foi substituído por `blockCostLimit` (em custo).

## [0.1.0] — 2026-08-08

Primeira versão: janela flutuante em Electron lendo os `.jsonl` de
`~/.claude/projects` de forma incremental, com cartões de resumo, gráfico da
última hora, abas de sessões/modelos/projetos, janelas do `/usage` e alertas de
limite por dia e por sessão.
