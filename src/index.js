'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const TARGET = 'node_modules';

// Diretórios que nunca vale a pena (ou é perigoso) varrer.
const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn']);

// Pseudo-sistemas de arquivos do Unix: varrer isso é lento e inútil.
const SKIP_ABSOLUTE = new Set(['/proc', '/sys', '/dev', '/run', '/snap']);

// node_modules dentro desses caminhos pertencem a instalações globais/toolchains
// (npm global, nvm, volta, ...). Apagá-los quebra o Node instalado na máquina,
// então ficam protegidos por padrão (use `includeProtected` para ignorar).
function defaultProtectedPaths() {
  const home = os.homedir();
  return [
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(home, '.nvm'),
    path.join(home, '.npm'),
    path.join(home, '.npm-global'),
    path.join(home, '.volta'),
    path.join(home, '.fnm'),
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.asdf'),
    path.join(home, '.n'),
    path.join(home, '.bun'),
    path.join(home, '.yarn'),
    path.join(home, '.config', 'yarn'),
    path.join(home, '.cache'),
    path.join(home, '.vscode'),
    path.join(home, '.vscode-server'),
    path.join(home, '.cursor'),
    path.join(home, 'Library'),
  ];
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function matchesExclude(fullPath, excludes) {
  return excludes.some((pattern) => fullPath.includes(pattern));
}

/**
 * Procura pastas node_modules a partir de `root`.
 * Não desce dentro de um node_modules encontrado (os aninhados vão junto)
 * e não segue links simbólicos.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=Infinity]
 * @param {string[]} [opts.exclude=[]] trechos de caminho a ignorar
 * @param {boolean} [opts.includeProtected=false]
 * @param {(err: Error, dir: string) => void} [opts.onError]
 * @returns {Promise<string[]>} caminhos absolutos encontrados
 */
async function findNodeModules(root, opts = {}) {
  const {
    maxDepth = Infinity,
    exclude = [],
    includeProtected = false,
    onError = () => {},
  } = opts;

  const start = path.resolve(root);
  const protectedPaths = includeProtected ? [] : defaultProtectedPaths();
  const found = [];

  const isProtected = (p) => protectedPaths.some((pp) => isInside(p, pp));

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      onError(err, dir);
      return;
    }

    const subdirs = [];
    for (const entry of entries) {
      // Dirent.isDirectory() é false para symlinks: não os seguimos.
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);

      if (matchesExclude(full, exclude)) continue;

      if (entry.name === TARGET) {
        if (!isProtected(full)) found.push(full);
        continue; // nunca desce dentro de node_modules
      }

      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (SKIP_ABSOLUTE.has(full)) continue;
      if (depth + 1 > maxDepth) continue;
      // Se o próprio diretório é protegido, nada lá dentro será removido.
      if (isProtected(full) && !isInside(start, full)) continue;

      subdirs.push(full);
    }

    await Promise.all(subdirs.map((d) => walk(d, depth + 1)));
  }

  // Caso o usuário aponte direto para um node_modules.
  if (path.basename(start) === TARGET) {
    const st = await fsp.lstat(start);
    if (st.isDirectory() && (includeProtected || !isProtected(start))) {
      return [start];
    }
    return [];
  }

  await walk(start, 0);
  return found.sort();
}

/**
 * Calcula o espaço real ocupado em disco (blocos alocados) por um diretório.
 * Arquivos com hardlink (ex.: pnpm) são contados uma única vez por `seen`.
 *
 * @param {string} dir
 * @param {Set<string>} [seen] inodes já contabilizados (compartilhável)
 * @returns {Promise<number>} bytes
 */
async function getSize(dir, seen = new Set()) {
  let total = 0;
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const stats = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(current, entry.name);
        try {
          return { full, entry, st: await fsp.lstat(full) };
        } catch {
          return null;
        }
      })
    );

    for (const item of stats) {
      if (!item) continue;
      const { full, st } = item;
      if (st.nlink > 1 && !st.isDirectory()) {
        const key = `${st.dev}:${st.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      total += typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
      if (st.isDirectory()) stack.push(full);
    }
  }

  try {
    const st = await fsp.lstat(dir);
    total += typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
  } catch {
    /* ignore */
  }

  return total;
}

/**
 * Remove um diretório recursivamente.
 * @param {string} dir
 */
async function remove(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2 });
}

/**
 * Dias desde a última modificação de um diretório.
 * @param {string} dir
 */
function ageInDays(dir) {
  const st = fs.statSync(dir);
  return (Date.now() - st.mtimeMs) / 86_400_000;
}

/**
 * Executa `fn` em `items` com concorrência limitada.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  findNodeModules,
  getSize,
  remove,
  ageInDays,
  mapLimit,
  formatBytes,
  defaultProtectedPaths,
};
