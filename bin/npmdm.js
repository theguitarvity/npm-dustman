#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const {
  findNodeModules,
  getSize,
  remove,
  ageInDays,
  mapLimit,
  formatBytes,
} = require('../src/index.js');
const pkg = require('../package.json');

const color = (() => {
  const on = process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36) };
})();

const HELP = `
${color.bold('npmdm')} — encontra e remove pastas node_modules para liberar espaço

${color.bold('Uso:')}
  npmdm [caminho...] [opções]

  Sem caminho, usa o diretório atual (.).

${color.bold('Opções:')}
  -y, --yes              Remove sem pedir confirmação
  -n, --dry-run          Só lista o que seria removido (não apaga nada)
  -d, --depth <n>        Profundidade máxima de busca (padrão: ilimitada)
  -e, --exclude <texto>  Ignora caminhos que contenham <texto> (repetível)
  -o, --older-than <n>   Só remove node_modules sem modificação há <n> dias
      --no-size          Não calcula tamanhos (bem mais rápido)
      --include-protected
                         Inclui node_modules de instalações globais
                         (~/.nvm, /usr/lib/node_modules, ~/.volta, ...)
  -q, --quiet            Saída mínima
  -h, --help             Mostra esta ajuda
  -v, --version          Mostra a versão

${color.bold('Exemplos:')}
  npmdm .                       # varre o diretório atual
  npmdm ~/projetos -n           # mostra quanto seria liberado
  npmdm ~/projetos -o 30 -y     # apaga os parados há mais de 30 dias
  npmdm ~ -e trabalho -e .Trash # ignora caminhos com "trabalho" ou ".Trash"
`;

function fail(msg) {
  process.stderr.write(`${color.red('erro:')} ${msg}\n`);
  process.exit(2);
}

function parse(argv) {
  const noSize = argv.includes('--no-size');
  argv = argv.filter((a) => a !== '--no-size');
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
        'dry-run': { type: 'boolean', short: 'n', default: false },
        depth: { type: 'string', short: 'd' },
        exclude: { type: 'string', short: 'e', multiple: true, default: [] },
        'older-than': { type: 'string', short: 'o' },
        'include-protected': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    fail(`${err.message}\nUse "npmdm --help" para ver as opções.`);
  }

  const { values, positionals } = parsed;
  const toNumber = (name, raw) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} precisa ser um número >= 0`);
    return n;
  };

  return {
    paths: positionals.length ? positionals : ['.'],
    yes: values.yes,
    dryRun: values['dry-run'],
    depth: toNumber('depth', values.depth) ?? Infinity,
    exclude: values.exclude,
    olderThan: toNumber('older-than', values['older-than']),
    size: !noSize,
    includeProtected: values['include-protected'],
    quiet: values.quiet,
    help: values.help,
    version: values.version,
  };
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(s|sim|y|yes)$/i.test(answer.trim()));
    });
  });
}

function shortPath(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function spinner(enabled) {
  if (!enabled || !process.stderr.isTTY) return { update() {}, stop() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let text = '';
  const timer = setInterval(() => {
    process.stderr.write(`\r\x1b[K${color.cyan(frames[i++ % frames.length])} ${text}`);
  }, 80);
  return {
    update(t) { text = t; },
    stop() { clearInterval(timer); process.stderr.write('\r\x1b[K'); },
  };
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void process.stdout.write(`${pkg.version}\n`);

  const log = opts.quiet ? () => {} : (s = '') => process.stdout.write(`${s}\n`);
  const roots = opts.paths.map((p) => path.resolve(expandHome(p)));

  for (const r of roots) {
    try {
      fs.accessSync(r);
    } catch {
      fail(`caminho não encontrado: ${r}`);
    }
  }

  // 1. Busca
  const spin = spinner(!opts.quiet);
  spin.update('Procurando node_modules...');
  let errors = 0;
  const found = new Set();
  for (const root of roots) {
    const list = await findNodeModules(root, {
      maxDepth: opts.depth,
      exclude: opts.exclude,
      includeProtected: opts.includeProtected,
      onError: () => { errors++; },
    });
    list.forEach((p) => found.add(p));
  }

  let targets = [...found].sort();

  // 2. Filtro por idade
  if (opts.olderThan !== undefined) {
    targets = targets.filter((p) => {
      try { return ageInDays(p) >= opts.olderThan; } catch { return false; }
    });
  }

  if (targets.length === 0) {
    spin.stop();
    log(color.green('Nenhum node_modules encontrado. Tudo limpo!'));
    return;
  }

  // 3. Tamanhos
  const seen = new Set();
  let sizes = targets.map(() => 0);
  if (opts.size) {
    let done = 0;
    sizes = await mapLimit(targets, 4, async (p) => {
      const s = await getSize(p, seen);
      spin.update(`Calculando tamanho... ${++done}/${targets.length}`);
      return s;
    });
  }
  spin.stop();

  const total = sizes.reduce((a, b) => a + b, 0);
  const sizeWidth = opts.size ? Math.max(...sizes.map((s) => formatBytes(s).length)) : 0;

  log(color.bold(`\nEncontrados ${targets.length} node_modules:\n`));
  targets.forEach((p, i) => {
    const size = opts.size ? color.yellow(formatBytes(sizes[i]).padStart(sizeWidth)) + '  ' : '';
    log(`  ${size}${shortPath(p)}`);
  });
  if (opts.size) log(`\n  ${color.bold('Total:')} ${color.yellow(formatBytes(total))}`);
  if (errors && !opts.quiet) {
    log(color.dim(`  (${errors} diretório(s) sem permissão de leitura foram ignorados)`));
  }
  log();

  if (opts.dryRun) {
    log(color.dim('Modo --dry-run: nada foi removido.'));
    return;
  }

  // 4. Confirmação
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      fail('terminal não interativo: use --yes para confirmar a remoção.');
    }
    const ok = await ask(`${color.bold('Remover tudo isso?')} [s/N] `);
    if (!ok) {
      log('Cancelado.');
      return;
    }
  }

  // 5. Remoção
  let freed = 0;
  let removed = 0;
  const failures = [];
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    try {
      await remove(p);
      removed++;
      freed += sizes[i];
      log(`  ${color.green('✔')} ${shortPath(p)}`);
    } catch (err) {
      failures.push(p);
      process.stderr.write(`  ${color.red('✖')} ${shortPath(p)} — ${err.code || err.message}\n`);
    }
  }

  const freedMsg = opts.size ? `, ${formatBytes(freed)} liberados` : '';
  log(`\n${color.green(color.bold('Pronto!'))} ${removed} removido(s)${freedMsg}.`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${color.red('erro:')} ${err.stack || err.message}\n`);
  process.exit(1);
});
