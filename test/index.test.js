'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findNodeModules, getSize, formatBytes } = require('../src/index.js');

const BIN = path.join(__dirname, '..', 'bin', 'npmdm.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npmdm-'));
  const mk = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content !== undefined) fs.writeFileSync(full, content);
    else fs.mkdirSync(full, { recursive: true });
  };
  mk('a/node_modules/lodash/index.js', 'x'.repeat(10_000));
  mk('a/node_modules/lodash/node_modules/inner/index.js', 'y');
  mk('b/c/node_modules/react/index.js', 'z'.repeat(5_000));
  mk('b/c/src/app.js', 'keep me');
  mk('deep/1/2/3/node_modules/x/index.js', 'w');
  mk('.git/node_modules/fake/index.js', 'git');
  mk('skipme/node_modules/x/index.js', 'q');
  // symlink para um node_modules não deve ser seguido
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link-to-a'));
  return root;
}

test('encontra node_modules sem descer neles nem seguir symlinks', async () => {
  const root = fixture();
  const found = await findNodeModules(root);
  const rel = found.map((p) => path.relative(root, p));
  assert.deepStrictEqual(rel, [
    'a/node_modules',
    'b/c/node_modules',
    'deep/1/2/3/node_modules',
    'skipme/node_modules',
  ]);
});

test('respeita --depth e --exclude', async () => {
  const root = fixture();
  const found = await findNodeModules(root, { maxDepth: 2, exclude: ['skipme'] });
  const rel = found.map((p) => path.relative(root, p));
  assert.deepStrictEqual(rel, ['a/node_modules', 'b/c/node_modules']);
});

test('caminho apontando direto para node_modules', async () => {
  const root = fixture();
  const found = await findNodeModules(path.join(root, 'a', 'node_modules'));
  assert.strictEqual(found.length, 1);
});

test('getSize conta hardlinks uma vez só', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npmdm-'));
  fs.mkdirSync(path.join(root, 'nm'));
  fs.writeFileSync(path.join(root, 'nm', 'big'), Buffer.alloc(100_000));
  const single = await getSize(path.join(root, 'nm'));
  fs.linkSync(path.join(root, 'nm', 'big'), path.join(root, 'nm', 'big2'));
  const linked = await getSize(path.join(root, 'nm'));
  assert.ok(single >= 100_000);
  assert.strictEqual(linked, single);
});

test('formatBytes', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(1536), '1.5 KB');
  assert.strictEqual(formatBytes(1024 ** 3), '1.0 GB');
});

test('CLI --dry-run não apaga nada', () => {
  const root = fixture();
  const out = execFileSync('node', [BIN, root, '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /Encontrados 4 node_modules/);
  assert.ok(fs.existsSync(path.join(root, 'a', 'node_modules')));
});

test('CLI sem --yes em terminal não interativo recusa', () => {
  const root = fixture();
  assert.throws(() =>
    execFileSync('node', [BIN, root], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  );
  assert.ok(fs.existsSync(path.join(root, 'a', 'node_modules')));
});

test('CLI --yes remove e preserva o resto', () => {
  const root = fixture();
  const out = execFileSync('node', [BIN, root, '-y', '-e', 'skipme'], { encoding: 'utf8' });
  assert.match(out, /3 removido/);
  assert.ok(!fs.existsSync(path.join(root, 'a', 'node_modules')));
  assert.ok(!fs.existsSync(path.join(root, 'b', 'c', 'node_modules')));
  assert.ok(fs.existsSync(path.join(root, 'b', 'c', 'src', 'app.js')));
  assert.ok(fs.existsSync(path.join(root, 'skipme', 'node_modules')));
  assert.ok(fs.existsSync(path.join(root, '.git', 'node_modules')));
  assert.ok(fs.lstatSync(path.join(root, 'link-to-a')).isSymbolicLink());
});

test('CLI --older-than filtra por idade', () => {
  const root = fixture();
  const old = new Date(Date.now() - 60 * 86_400_000);
  fs.utimesSync(path.join(root, 'a', 'node_modules'), old, old);
  const out = execFileSync('node', [BIN, root, '-y', '-o', '30'], { encoding: 'utf8' });
  assert.match(out, /1 removido/);
  assert.ok(!fs.existsSync(path.join(root, 'a', 'node_modules')));
  assert.ok(fs.existsSync(path.join(root, 'b', 'c', 'node_modules')));
});
