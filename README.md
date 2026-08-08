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

O monitor faz um scan inicial de todos os arquivos (~1,6s para 450 MB) e depois,
a cada 1,5s, lê apenas os bytes novos de cada arquivo, guardando o offset de onde
parou. Nada sai da máquina.

Chamadas repetidas são descartadas por `message.id` + `requestId` — a mesma
chamada reaparece quando uma sessão é retomada e o transcript é copiado para um
arquivo novo. Entradas `<synthetic>` e respostas marcadas com
`isApiErrorMessage` não têm chamada de API por trás e ficam de fora da contagem.

## O painel

**Bloco de 4h (destaque do topo)** — a janela que de fato limita o uso: tokens
consumidos, custo, quanto do tempo já passou, ritmo em tokens/min e a projeção
para o fim do bloco mantendo esse ritmo.

A duração vem de `BLOCK_HOURS` em `src/watcher.js` e viaja junto com os dados,
então trocar essa constante já ajusta o cálculo e todos os rótulos. Se o seu
`/usage` reportar outra janela, é a única linha a mudar.

**Cartões** — Hoje, Sessão (a de atividade mais recente) e Ritmo (média de
tokens/min dos últimos 5 minutos fechados, com a estimativa de custo por hora).

**Barra de composição** — proporção entre input, output, cache escrito e cache
lido. Em uso normal o cache lido domina; é o que mostra o quanto o contexto está
sendo relido a cada chamada.

**Gráfico** — tokens por minuto nos últimos 60 minutos, com pico marcado e
leitura por minuto ao passar o mouse.

**Abas**

- **Ao vivo** — últimas 8 chamadas, com idade, modelo, projeto e tokens. Menos de
  15s aparece em verde e a mais recente entra deslizando.
- **Uso** — as mesmas janelas do `/usage` (detalhes abaixo)
- **Modelos** — cada modelo com chamadas, tokens, participação e custo. Quando um
  modelo consome algo, um badge verde `+153.2k` aparece por 6 segundos.
- **Projetos** — os 6 maiores por custo, o resto agrupado em uma linha

O ponto ao lado do título pulsa quando existe sessão ativa (com tokens nos
últimos 5 minutos).

## A aba Uso

Reproduz o formato do `/usage` com os dados locais:

- **Bloco de 4h** — tokens consumidos no bloco vigente, quanto falta para o reset
  e quanto do tempo já passou. O bloco é ancorado na **hora cheia** da primeira
  chamada; um bloco novo começa quando o anterior completa as 4h ou quando passam
  mais de 4h sem nenhuma chamada.
- **Últimos 7 dias** — os 7 dias corridos até hoje, com a fatia de cada modelo
- **Consumo diário** — barra por dia nos últimos 14 dias, com hoje destacado

## Porcentagem do limite (calibração)

O `/usage` mostra a **porcentagem do limite do seu plano**. Esse número vem do
servidor da Anthropic e não existe em nenhum arquivo local — o campo `rateLimits`
dos transcripts vem sempre nulo. Mas a porcentagem é só o consumo do bloco
dividido pela cota, e o consumo já é medido aqui. Então basta informar a
porcentagem uma vez para a cota ficar conhecida:

1. rode `/usage` no Claude Code e veja a porcentagem do bloco
2. abra as preferências do monitor e digite esse número em **% que o /usage
   mostra agora**
3. a cota deduzida aparece em **Cota do bloco (USD equiv.)** e fica salva

A partir daí o destaque do topo mostra a porcentagem no lugar do total, colorida
em amarelo no aviso e vermelha ao estourar, com a projeção de onde o bloco
termina no ritmo atual.

### Por que a cota é medida em custo

A cota do plano é **ponderada por modelo**: um token de Opus consome muito mais
limite que um de Haiku. Se a régua fosse a contagem bruta de tokens, trocar de
modelo no meio do bloco jogaria a porcentagem fora e exigiria recalibrar.

O custo estimado já embute exatamente esse peso, então ele é a régua. Os mesmos
5M de tokens entram como 7,5% em Opus 5, 4,5% em Sonnet 5 e 1,5% em Haiku 4.5 —
a correção por modelo é automática, sem recalibrar.

Ainda assim é uma estimativa: a ponderação real do servidor pode não ser
exatamente a razão de preço. Se o número divergir do `/usage`, recalibre.

## Alertas

Todos os limites vêm **desligados** por padrão. Abra as preferências pelo ícone
de controles na barra do topo para definir:

- **Cota do bloco** (USD equivalente) — preenchida pela calibração acima; é o
  alerta que corresponde ao que o `/usage` reporta
- **Tokens/dia** e **Tokens/sessão** (em milhões) — a métrica que vale em plano
  de assinatura
- **Custo/dia** e **Custo/sessão** (USD) — só faz sentido se você usa API paga
- **Avisar em (%)** — dispara o aviso amarelo antes de estourar (padrão 80%)

Ao atingir a porcentagem de aviso, a barra fica amarela e sai uma notificação do
Windows. Ao estourar 100%, tudo vira vermelho, vem notificação crítica e a janela
pisca na barra de tarefas.

Cada limite alerta **uma vez por nível** — sem repetir a cada 1,5s. O contador
diário reinicia na virada do dia **no horário local**, e mudar um limite rearma o
alerta na hora. `0` desliga. As configurações ficam em
`%APPDATA%/token-monitor/config.json`.

## Sobre os custos

São **estimativas** calculadas em `src/pricing.js` a partir do preço de tabela da
API, em USD por milhão de tokens. Só input e output são tabelados; as taxas de
cache são derivadas do preço de input, que é como a tabela oficial funciona:

| Componente         | Taxa           |
| ------------------ | -------------- |
| cache write 5 min  | 1,25 × input   |
| cache write 1 hora | 2,00 × input   |
| cache read         | 0,10 × input   |

A divisão entre cache de 5 min e de 1 hora vem do campo `usage.cache_creation`
de cada chamada. Ela muda bastante a conta: em uso pesado o cache de 1 hora é a
maior fatia, e cobrá-lo como se fosse de 5 min subestima o custo em ~60% desse
componente.

A tabela também é sensível à versão: Opus 4, 4.1 e 3 ficam na faixa antiga
(15/75), e de Opus 4.5 em diante o preço é 5/25.

A tabela foi conferida contra o `costUSD` que o próprio Claude Code grava em
`~/.claude.json` (campo `lastModelUsage`), com **0,00% de erro** em todas as
amostras de Opus 5, Opus 5 `[1m]` e Haiku 4.5 — o que confirma tanto os preços
por modelo quanto os multiplicadores de cache acima.

Se você usa Claude Code por assinatura (Pro/Max), esse valor **não é o que você
paga** — serve como referência de peso relativo entre modelos, projetos e dias.
Para controle real de uso nesse caso, use os limites em tokens.

O modelo `fable` está com preço de sonnet por falta de tabela pública.

## Controles

A barra do topo arrasta a janela. Os botões à direita: preferências, "sempre no
topo" (ligado por padrão), minimizar e fechar. No rodapé, o botão abre a pasta
dos transcripts.

## Arquivos

```
src/watcher.js    leitura incremental dos .jsonl, agregação e janelas de uso
src/pricing.js    tabela de preços por versão de modelo e cálculo de custo
src/time.js       chaves de dia/minuto/hora compartilhadas
src/alerts.js     níveis de alerta e controle de disparo único por nível
src/config.js     leitura/escrita das configurações
src/main.js       processo principal do Electron, janela e notificações
src/preload.js    ponte IPC (contextIsolation ligado)
renderer/         interface: HTML, CSS e JS puro, sem framework
```

Sem dependências além do Electron. O renderer roda com `contextIsolation` ligado,
`nodeIntegration` desligado e uma CSP que bloqueia qualquer carregamento externo —
todo acesso a disco fica no processo principal.
