# Pi Browser Harness

Controle nativo de navegador no Pi, usando [browser-use/browser-harness](https://github.com/browser-use/browser-harness) **0.1.13**. Ferramenta `browser_harness` e skill `pi-browser-harness`, no formato do browser-use 1.0: sete ações (`status`, `open`, `exec`, `state`, `screenshot`, `close`, `read`). `exec` roda uma célula Python numa aba própria, com variáveis que persistem por aba e o estado acessível compacto (`[id] papel "nome"`) impresso depois de cada passo que age. `state` e `screenshot` (JPEG, lado maior 1280) só leem. O Chrome não desenha uma aba que não é a da frente da janela: se a captura não responde em 4 s, a aba é trazida para a frente e a captura é pedida de novo, uma vez.

## Instalação

```sh
git clone https://github.com/lennix1337/pi-browser-harness.git
cd pi-browser-harness
npm ci --ignore-scripts
npm run setup
```

Requer Node 24.2+, `uv` e Edge/Chrome instalado. `uv sync --frozen --python 3.12` usa ambiente `.venv` local e dependências fixadas por `uv.lock`; não instala ferramentas globais. Adicione o caminho absoluto deste pacote a `packages` em `~/.pi/agent/settings.json` e faça `/reload` uma vez. Os dotfiles do proprietário já contêm pacote, pin e instaladores Windows/macOS.

```sh
npm run browser -- start            # perfil isolado, janela visível
npm run browser -- start --headless # teste descartável
npm run browser -- status           # somente registro local
npm run browser -- stop             # somente a instância própria identificada
```

O launcher imprime um endpoint de porta dinâmica. Passe esse endpoint em `browser_harness({action:"open",endpoint:"http://127.0.0.1:PORT",url:"https://example.com"})`. `status` da ferramenta não inicia conexão/navegador. `PI_BROWSER_HARNESS_CDP_URL` pode configurar o endpoint padrão; não confunda a porta com comprovação do perfil. `PI_BROWSER_HARNESS_EXECUTABLE` seleciona um executável instalado, `PI_BROWSER_HARNESS_HOME` muda a pasta de estado/capturas (padrão: `~/.cache/pi-browser-harness`).

O navegador isolado fecha sozinho depois de 30 minutos sem nenhuma ação de página (`open`, `exec`, `state`...; `status` e `read` não contam). A extensão confere a cada minuto, fecha só a instância registrada em `browser.json` cuja identidade confere, com o mesmo fechamento verificado do `stop`, e mantém o perfil. `PI_BROWSER_HARNESS_IDLE_MINUTES` muda o prazo; `0` desliga.

`PI_BROWSER_HARNESS_ONLY_ROOT=<raiz do pacote>` (para benchmarks que carregam duas cópias do pacote com `pi -e`): só a cópia cuja raiz resolve para esse caminho registra `browser_harness`; qualquer outra não registra nada (nem ferramenta, nem timer ocioso). Vazio ou ausente mantém o comportamento normal. `status` informa `root` e, em um checkout, `head`.

## Padrão de uso

Leia [a skill](skills/pi-browser-harness/SKILL.md) para o fluxo e regras DentAI. Use **Code Mode** para agrupar I/O independente ou combinar aquisição e cálculo já conhecido; use **REPL** para cálculo puro com estado entre etapas dependentes; use **Browser Harness** quando precisa interagir com o navegador ou renderização JS. Pesquisa/leitura pública simples continua nas ferramentas web.

A primeira operação cria aba própria em segundo plano e retorna seu ID. As operações seguintes usam ID + sessão CDP explícita, nunca a aba ativa. A aba nasce em segundo plano, mas com emulação de foco: sem isso o Chromium roda timers encadeados a cerca de um por segundo (medido: 12 `setTimeout` de 10 ms levavam ~11 s; com a emulação, ~0,2 s). Toda resposta começa com uma linha JSON `{"status","tab","url"}`; `status` é `ok`, `error` (nada foi despachado) ou `outcome_uncertain` (um efeito pode ter ocorrido: leia `state`, não repita). A saída passa de 12.000 caracteres? Fica inteira atrás de um recibo (`read`, 8 resultados, até 1 MiB cada).

Auxiliares da célula: `goto`, `state`, `click(id)`, `type(id, texto)`, `press`, `scroll`, `upload`, `js(expr)`, `wait_for`, `wait_for_network_idle`, `network(filtro)`, `intercept`/`intercept_status`/`intercept_stop`, `dialog(accept)`, `screenshot` e `cdp(método, **params)`. `alert` e `beforeunload` são aceitos sozinhos; `confirm` e `prompt` são recusados e reportados, a menos que `dialog(accept=True)` rode antes. Estourou o `timeout` (padrão 30 s, máximo 300 s): o worker é encerrado, `outcome_uncertain` com "REPL restarted, variables lost", e a aba continua aberta. Chamadas de uma sessão formam uma fila (FIFO).

O JSON de acessibilidade, `evaluate`, `navigate`, `click`, `type`, `network` e `intercept_*` como ações foram removidos; ações antigas respondem com o substituto (`inspect -> state`; `click/type/evaluate/navigate -> exec`).

O módulo de estado `python/ax.py` vem do browser-use **1.0.0** sem alteração (MIT, `python/ax.NOTICE`); `test/vendor_test.py` fixa o hash. Os eventos de rede/diálogo chegam por um roteador próprio, por sessão, e cada sessão Pi usa o seu daemon upstream (um daemon tem um único buffer de eventos e ler esvazia o buffer).

## Filtros, interceptação e edição

`network(method=, urlContains=, resourceType=, status=)` filtra as observações da aba (AND). Para modificar **requisições futuras**, use regras automáticas na aba própria, dentro de uma célula:

```python
intercept([{
  "match": {"urlPattern": "http://127.0.0.1:PORT/api/*", "method": "POST", "urlContains": "/save"},
  "edit": {"method": "PUT", "headers": {"X-Test": "edited", "X-Remove": None}, "postData": '{"name":"example"}'},
  "maxMatches": 1,
}])
intercept_status()
# Execute the authorized page action, then verify the server response and resulting state.
intercept_stop()
```

- `match` aceita glob de URL absoluto HTTP(S), trecho de URL, método (sem diferenciar maiúsculas) e `resourceType` CDP. Condições são AND; ganha a primeira regra compatível ainda não esgotada. Em `Fetch.requestPaused`, Chromium pode classificar `fetch()` como **XHR**, enquanto `network` mostra **Fetch**; confira `lastResourceType` no status ou omita essa condição.
- Até 16 regras/256 KiB. `maxMatches` limita cada regra a 1 por padrão (até 100). Sem repetição de requests passados e sem pausa manual aguardando outra chamada da ferramenta.
- `edit` substitui método, URL absoluta **da mesma origem**, corpo UTF-8 (`postData`, até 65.536 caracteres, inclusive vazio) e/ou mescla cabeçalhos sem diferenciar maiúsculas; `null` remove. Chromium recalcula tamanho do corpo. Host, Content-Length, Connection e Transfer-Encoding não podem ser editados. `postData` é substituição completa, não merge de JSON.
- Regras precisam ser paradas antes de substituir. `intercept_status()` retorna contagens e até 100 eventos em memória; mostra método, URL sem query/fragmento/credenciais, nomes dos campos e confirmação CDP. **Não inclui valores de cabeçalhos/corpos nem regras**. Caminhos de URL ainda podem conter identificadores: trate os metadados como privados. A captura `network` existente é separada e pode conter dados da requisição.
- URL de outra origem é ignorada e registrada como `skipped_cross_origin`, preservando a requisição original. Falha de transporte/continuação desconecta a sessão e não repete efeitos. `continued` só confirma despacho CDP, não aceitação pelo servidor.
- `intercept_stop()`, fechamento da aba e EOF/shutdown liberam a conexão CDP dedicada. Morte do worker também desconecta a sessão, liberando Fetch; o próximo worker **não reinstala regras antigas**. Isso é validado no smoke local.

## Limites e segurança

- Somente endpoints CDP HTTP de loopback explícitos; sem autodescoberta, inicialização de perfil pessoal ou fallback cloud. O Python verifica também a origem WebSocket anunciada e recusa redirects.
- Proteção contra engano, não sandbox: `cdp()` sempre usa a sessão da aba própria; `Target.*` e `Browser.*` são recusados (aba nova só por `open`); células que importam transporte ou processos são recusadas antes de rodar; o worker recebe só um ambiente permitido (sem tokens). Exec também vale em navegadores aprovados que não são o isolado (por exemplo o perfil `dentai` do Brave), sempre só nas abas da própria ferramenta.
- Abas de outra sessão, inclusive abas pessoais vazias, não podem ser adotadas ou fechadas. O upstream `new_tab` pode reaproveitar uma aba vazia; esta integração cria um target novo diretamente e registra sua identidade antes de navegar.
- Sem gravações contínuas, telemetria, marcadores de título, importação de cookies, login ou API paga. Capturas explícitas continuam disponíveis.
- O processo upstream mantém uma aba branca de infraestrutura e conexão por endpoint. O estado/recibos de cada sessão Pi são separados. Reload perde os handles: conclua ou registre trabalho aberto antes. Não há readoção automática.
- Falha/timeout/abort após despacho retorna `outcome_uncertain`; sem retry de efeitos nem redirecionamento silencioso de sessões CDP expiradas. O adaptador limita tempo/saída e serializa ações por sessão.
- Não é uma sandbox de autoridade: JS da página pode escrever no site e endpoints loopback podem expor dados pessoais. As permissões da tarefa, verificação de perfil/conta e confirmações continuam obrigatórias.
- Outras operações CDP ficam por `cdp()` dentro da célula, sempre presas à aba própria.

## Validação

```sh
npm run check
npm test
npm run mutations
uv run --frozen --offline python -m unittest discover -s test -p "*_test.py"
npm run smoke
```

As mesmas receitas estão em `.pi/checks.json`. O smoke usa pacote real via `DefaultResourceLoader` → ferramenta nativa → Python upstream → daemon → CDP → formulário HTTP local; verifica texto digitado, um POST, resultado visível, JPEG, aba sentinela intacta, recusa de aba alheia e fechamento dos recursos próprios. A edição é confirmada pelo servidor local (URL, método, cabeçalhos, corpo Unicode); também cobre variáveis por aba, recusas do guarda, diálogos, prazo estourado com reinício do REPL, filtros, limite de aplicações, URL de outra origem recusada, parada, EOF e morte do worker sem replay. Sem provedor/modelo. Artefatos ficam fora do Git em `../local-validation/runs/browser-harness/` (ou `PI_BROWSER_HARNESS_EVIDENCE`). Windows/Edge local validado; CI testa Windows/Linux, macOS depende de validação na máquina alvo.

## Origem

Implementação Pi própria, não um fork integral. Atribuição: browser-harness, Browser Use, licença MIT; upstream inspecionado em `4ced8e0087d2d45ea2d08c00cb62449b2d94a90e`. O pacote Python distribuído é fixado em 0.1.13 com hashes do lockfile. Sem release npm ou serviço externo.
