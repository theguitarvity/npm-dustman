# npm-dustman 🧹

CLI para ambientes Unix (Linux, macOS, BSD) que **encontra e remove todas as pastas `node_modules`** a partir de um diretório, para liberar espaço em disco.

Zero dependências — só Node.js ≥ 18.

## Instalação

```bash
npm install -g npm-dustman
# ou, a partir deste repositório:
npm link
```

## Uso

```bash
npmdm [caminho...] [opções]
```

Sem caminho, usa o diretório atual.

```bash
npmdm .                        # varre o diretório atual, lista e pede confirmação
npmdm ~/projetos -n            # só mostra quanto seria liberado (dry-run)
npmdm ~/projetos -y            # remove sem perguntar
npmdm ~/projetos -o 30 -y      # remove só os que estão parados há 30+ dias
npmdm ~ -e trabalho -e .Trash  # ignora caminhos que contenham esses textos
npmdm ~/a ~/b                  # vários caminhos de uma vez
```

Exemplo de saída:

```
Encontrados 3 node_modules:

  412.3 MB  ~/projetos/loja/node_modules
  198.0 MB  ~/projetos/blog/node_modules
   88.7 MB  ~/projetos/api/node_modules

  Total: 699.0 MB

Remover tudo isso? [s/N] s
  ✔ ~/projetos/api/node_modules
  ✔ ~/projetos/blog/node_modules
  ✔ ~/projetos/loja/node_modules

Pronto! 3 removido(s), 699.0 MB liberados.
```

### Opções

| Opção | Descrição |
|---|---|
| `-y, --yes` | Remove sem pedir confirmação |
| `-n, --dry-run` | Só lista o que seria removido |
| `-d, --depth <n>` | Profundidade máxima de busca |
| `-e, --exclude <texto>` | Ignora caminhos que contenham `<texto>` (pode repetir) |
| `-o, --older-than <n>` | Só remove `node_modules` sem modificação há `<n>` dias |
| `--no-size` | Não calcula tamanhos (muito mais rápido em árvores grandes) |
| `--include-protected` | Inclui `node_modules` de instalações globais (veja abaixo) |
| `-q, --quiet` | Saída mínima |
| `-h, --help` / `-v, --version` | Ajuda / versão |

## Segurança

- **Pede confirmação** antes de apagar (exceto com `--yes`). Em terminal não interativo (scripts, CI) sem `--yes`, ele aborta.
- **Não segue links simbólicos** — nunca apaga algo fora da árvore que você apontou.
- **Não entra** em `node_modules` encontrados (os aninhados vão junto), nem em `.git`, `/proc`, `/sys`, `/dev`, `/run`.
- **Protege instalações globais** por padrão, para não quebrar seu Node/npm: `~/.nvm`, `~/.volta`, `~/.fnm`, `~/.npm`, `~/.asdf`, `~/.bun`, `~/.cache`, `~/.vscode*`, `/usr/lib/node_modules`, `/usr/local/lib/node_modules`, entre outros. Use `--include-protected` se realmente quiser incluí-los.
- O tamanho exibido é o **espaço real em disco** (blocos alocados), contando arquivos com hardlink (ex.: pnpm) só uma vez.

## API programática

```js
const { findNodeModules, getSize, remove, formatBytes } = require('npm-dustman');

const dirs = await findNodeModules('/home/eu/projetos', { maxDepth: 5, exclude: ['keep'] });
for (const dir of dirs) {
  console.log(dir, formatBytes(await getSize(dir)));
  await remove(dir);
}
```

## Desenvolvimento

```bash
npm test
```

## Licença

MIT
