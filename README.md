# Token Monitor

Janela flutuante que acompanha, em tempo real, o consumo de tokens do Claude Code
em todas as sessões e projetos da máquina.

## Rodar

Duplo clique em `Iniciar Monitor.bat`, ou pelo terminal:

```
npm install
npm start
```

A janela abre no canto superior direito, sempre acima das outras.

## Como funciona

O Claude Code grava um arquivo `.jsonl` por sessão em
`~/.claude/projects/<projeto>/<session-id>.jsonl`. Cada resposta do assistente
carrega um bloco `usage` com `input_tokens`, `output_tokens`,
`cache_creation_input_tokens` e `cache_read_input_tokens`.

O monitor faz um scan inicial de todos os arquivos (~2,5s para 450 MB) e depois,
a cada 1,5s, lê apenas os bytes novos de cada arquivo, guardando o offset de onde
parou. Chamadas repetidas são descartadas pelo `requestId`. Nada sai da máquina.

## O painel

**Cartões do topo**

- **Hoje** — tokens do dia corrente e custo estimado
- **Sessão atual** — a sessão com atividade mais recente, e o projeto dela
- **Taxa** — média de tokens/min dos últimos 5 minutos
- **Modelo ativo** — modelo em uso agora e custo acumulado da sessão

**Barra de composição** — proporção entre input, output, cache write e cache
read. Em uso normal o cache read domina; é o que mostra o quanto o contexto está
sendo relido a cada chamada.

**Gráfico** — tokens por minuto nos últimos 60 minutos, com o pico marcado.

**Abas** (a lista rola dentro de si mesma; o painel de cima fica sempre visível)

- **Ao vivo** — últimas 8 chamadas, com idade, modelo, projeto e tokens. Menos de
  15s aparece em verde e a mais recente entra deslizando.
- **Uso** — as mesmas janelas do `/usage` (detalhes abaixo)
- **Modelos** — cada modelo com chamadas, tokens, participação e custo. Quando um
  modelo consome algo, um badge verde `+153.2k` aparece por 6 segundos.
- **Projetos** — os 5 maiores por custo, o resto agrupado em uma linha

O ponto ao lado do título pulsa quando existe sessão ativa (com tokens nos
últimos 5 minutos).

## A aba Uso

Reproduz o formato do `/usage` com os dados locais:

- **Bloco de 5h** — tokens consumidos no bloco vigente, quanto falta para o reset
  e quanto do tempo já passou. Um bloco começa na primeira chamada e dura 5 horas
  fixas; a chamada seguinte ao fim dele abre um bloco novo. Sem bloco aberto, o
  painel avisa que ele começa na próxima chamada.
- **Últimos 7 dias** — total da janela semanal, com a fatia de cada modelo
- **Consumo diário** — barra por dia nos últimos 14 dias, com o dia de hoje
  destacado em verde

**Limitação:** o `/usage` real mostra a **porcentagem do limite do seu plano**.
Esse número vem do servidor da Anthropic e não existe em nenhum arquivo local,
então aqui só aparece o consumo absoluto. As janelas de tempo são as mesmas; a
régua do plano não.

## Alertas

Todos os limites vêm **desligados** por padrão. Clique em ⚙ para definir:

- **Tokens/dia** e **Tokens/sessão** (em milhões) — a métrica que vale em plano
  de assinatura
- **Custo/dia** e **Custo/sessão** (USD) — só faz sentido se você usa API paga
- **Avisar em (%)** — dispara o aviso amarelo antes de estourar (padrão 80%)

Ao atingir a porcentagem de aviso, a barra fica amarela e sai uma notificação do
Windows. Ao estourar 100%, tudo vira vermelho, vem notificação crítica e a janela
pisca na barra de tarefas.

Cada limite alerta **uma vez por nível** — sem repetir a cada 1,5s. O contador
diário reinicia na virada do dia, e mudar um limite rearma o alerta na hora. `0`
desliga. As configurações ficam em `%APPDATA%/token-monitor/config.json`.

## Sobre os custos

São **estimativas** calculadas em `src/pricing.js` a partir do preço de tabela da
API, em USD por milhão de tokens.

Se você usa Claude Code por assinatura (Pro/Max), esse valor **não é o que você
paga** — serve como referência de peso relativo entre modelos, projetos e dias.
Para controle real de uso nesse caso, use os limites em tokens.

O modelo `fable` está com preço de sonnet por falta de tabela pública. Entradas
`<synthetic>` são mensagens geradas localmente pelo CLI, sem chamada de API, e
por isso somam custo zero.

## Controles

- A barra do topo arrasta a janela
- 📌 liga/desliga "sempre no topo" (ligado por padrão)
- ⚙ abre os limites
- 📁 abre a pasta dos transcripts

## Arquivos

```
src/watcher.js    leitura incremental dos .jsonl, agregação e janelas de uso
src/pricing.js    tabela de preços e cálculo de custo
src/alerts.js     níveis de alerta e controle de disparo único por nível
src/config.js     leitura/escrita das configurações
src/main.js       processo principal do Electron, janela e notificações
src/preload.js    ponte IPC (contextIsolation ligado)
renderer/         interface: HTML, CSS e JS puro, sem framework
```

Sem dependências além do Electron. O renderer roda com `contextIsolation` ligado
e `nodeIntegration` desligado — todo acesso a disco fica no processo principal.
