#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { gzip, gunzip } from 'node:zlib';
import { promisify, parseArgs } from 'node:util';
import os from 'node:os';

const zip = promisify(gzip), unzip = promisify(gunzip);
const hash = bytes => createHash('sha512').update(bytes).digest('hex');
const seconds = start => (performance.now() - start) / 1000;
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.access(file).then(() => true, () => false);
async function write(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
async function json(file, value) { await write(file, JSON.stringify(value, null, 2) + '\n'); }
async function pool(items, count, work) {
  let next = 0;
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
async function run(command, args, log) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, NIX_BUILD_CORES: '4', DRVJS_JOBS: '4' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.on('data', bytes => stderr += bytes);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  if (log) await write(log, result.stdout + result.stderr);
  assert.equal(result.code, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return { seconds: seconds(start), stdout: result.stdout.trim() };
}
async function walk(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await walk(root, name));
    else result.push(name);
  }
  return result.sort();
}
function verify(bytes, digest) { assert.equal(hash(bytes), digest, 'content digest mismatch'); }
function verifySRI(bytes, integrity) {
  const [algorithm, digest] = integrity.split('-');
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), digest, 'archive SRI mismatch');
}

async function prepare(args) {
  const started = performance.now();
  const root = path.resolve(args.out), exported = path.resolve(args.export);
  await fs.mkdir(root);
  const plan = await readJSON(path.join(exported, 'plan.json'));
  const target = process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';
  const active = new Set(plan.targetPackages[target]);
  const packages = plan.packages.filter(pkg => active.has(pkg.id));
  const archives = [];
  const downloadStart = performance.now();
  await pool(packages, 16, async pkg => {
    assert(!pkg.private, 'prototype only accepts public registry packages');
    const response = await fetch(pkg.url);
    assert(response.ok, `download ${pkg.id}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifySRI(bytes, pkg.hash);
    const digest = hash(bytes), key = `archives/${digest}`;
    await write(path.join(root, key), bytes);
    archives.push({ id: pkg.id, digest, integrity: pkg.hash, key, bytes: bytes.length });
  });
  archives.sort((a, b) => a.id.localeCompare(b.id));
  const downloadSeconds = seconds(downloadStart);
  const sources = path.join(root, 'tarballs.json');
  await json(sources, archives.map(pkg => ({ id: pkg.id, file: path.join(root, pkg.key) })));
  const retained = path.join(root, 'retained');
  const storeBuild = await run(args.binary, [
    'assemble', path.join(exported, 'project'), retained, sources, '--keep-verification-store',
  ], path.join(root, 'prepare.log'));
  const objectStart = performance.now();
  const store = path.join(retained, '.pnpm-store');
  const entries = [], unique = new Map();
  for (const name of await walk(store)) {
    const file = path.join(store, name), stat = await fs.lstat(file);
    assert(stat.isFile(), `unexpected non-file in pnpm store: ${name}`);
    const bytes = await fs.readFile(file), digest = hash(bytes);
    entries.push({ path: name, digest, mode: stat.mode & 0o777, bytes: bytes.length });
    if (!unique.has(digest)) {
      const compressed = await zip(bytes, { level: 6 });
      await write(path.join(root, 'objects', digest), compressed);
      unique.set(digest, { bytes: bytes.length, compressedBytes: compressed.length });
    }
  }
  const spec = {
    version: 1, source: path.join(exported, 'project'), archives,
    indexes: entries.filter(entry => entry.path.startsWith('v10/index/')),
    corpus: {
      packages: archives.length, storeEntries: entries.length, uniqueObjects: unique.size,
      tarBytes: archives.reduce((n, p) => n + p.bytes, 0),
      rawUniqueBytes: [...unique.values()].reduce((n, p) => n + p.bytes, 0),
      compressedObjectBytes: [...unique.values()].reduce((n, p) => n + p.compressedBytes, 0),
    },
    preparation: { downloadSeconds, retainedAssemblySeconds: storeBuild.seconds,
      objectEncodingSeconds: seconds(objectStart), totalSeconds: seconds(started) },
  };
  await json(path.join(root, 'spec.json'), spec);
  console.log(JSON.stringify({ root, ...spec.corpus, preparation: spec.preparation }));
}

async function serve(roots, latency) {
  const metrics = { requests: 0, bytes: 0 };
  async function lookup(key) {
    assert(/^(archives|objects)\/[a-f0-9]{128}$/.test(key), 'invalid object key');
    for (const root of roots) {
      const file = path.join(root, key);
      if (await exists(file)) return fs.readFile(file);
    }
    throw new Error(`missing object ${key}`);
  }
  const server = http.createServer(async (req, res) => {
    try {
      metrics.requests++;
      if (latency > 0) await new Promise(resolve => setTimeout(resolve, latency));
      let bytes;
      if (req.method === 'POST' && req.url === '/batch') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          assert(size <= 1024 * 1024, 'batch request too large');
          chunks.push(chunk);
        }
        const digests = JSON.parse(Buffer.concat(chunks));
        assert(Array.isArray(digests) && digests.length <= 128, 'invalid batch');
        const frames = [];
        for (const digest of digests) {
          const raw = await unzip(await lookup(`objects/${digest}`));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(raw.length);
          frames.push(length, raw);
        }
        bytes = await zip(Buffer.concat(frames), { level: 6 });
      } else {
        assert(req.method === 'GET', 'unsupported method');
        bytes = await lookup(req.url.slice(1));
      }
      metrics.bytes += bytes.length;
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(bytes);
    } catch (error) {
      res.writeHead(400);
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, metrics, url: `http://127.0.0.1:${server.address().port}` };
}

async function get(url, options) {
  const response = await fetch(url, options);
  assert(response.ok, `${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function install(spec, mode, cache, out, binary, url, concurrency) {
  const started = performance.now();
  const fetchStart = performance.now();
  const tarballs = path.join(cache, 'tarballs.json');
  let entries, missingObjects = 0;
  if (mode === 'tar') {
    await pool(spec.archives, concurrency, async pkg => {
      const file = path.join(cache, 'archives', pkg.digest);
      if (!await exists(file)) {
        missingObjects++;
        const bytes = await get(`${url}/${pkg.key}`);
        verifySRI(bytes, pkg.integrity);
        await write(file, bytes);
      }
    });
    await json(tarballs, spec.archives.map(pkg => ({
      id: pkg.id, file: path.join(cache, 'archives', pkg.digest),
    })));
  } else {
    async function download(digests) {
      const missing = [];
      for (const digest of new Set(digests)) {
        assert(/^[a-f0-9]{128}$/.test(digest));
        if (!await exists(path.join(cache, 'objects', digest))) missing.push(digest);
      }
      missingObjects += missing.length;
      async function save(digest, bytes) {
        verify(bytes, digest);
        await write(path.join(cache, 'objects', digest), bytes);
      }
      if (mode === 'files') {
        await pool(missing, concurrency, async digest =>
          save(digest, await unzip(await get(`${url}/objects/${digest}`))));
      } else {
        const batches = [];
        for (let offset = 0; offset < missing.length; offset += 128) batches.push(missing.slice(offset, offset + 128));
        await pool(batches, concurrency, async digests => {
          const packed = await unzip(await get(`${url}/batch`, {
            method: 'POST', body: JSON.stringify(digests),
          }));
          let offset = 0;
          for (const digest of digests) {
            const size = packed.readUInt32BE(offset);
            offset += 4;
            const bytes = packed.subarray(offset, offset + size);
            assert.equal(bytes.length, size);
            await save(digest, bytes);
            offset += size;
          }
          assert.equal(offset, packed.length);
        });
      }
    }
    await download(spec.indexes.map(entry => entry.digest));
    const files = new Map(spec.indexes.map(entry => [entry.path, entry]));
    for (const entry of spec.indexes) {
      const bytes = await fs.readFile(path.join(cache, 'objects', entry.digest));
      verify(bytes, entry.digest);
      const index = JSON.parse(bytes);
      for (const info of Object.values(index.files)) {
        const [algorithm, encoded] = info.integrity.split('-');
        assert.equal(algorithm, 'sha512');
        const digest = Buffer.from(encoded, 'base64').toString('hex');
        const executable = (info.mode & 0o111) !== 0;
        const name = `v10/files/${digest.slice(0, 2)}/${digest.slice(2)}${executable ? '-exec' : ''}`;
        files.set(name, { path: name, digest, bytes: info.size, mode: executable ? 0o755 : 0o644 });
      }
    }
    entries = [...files.values()];
    await download(entries.map(entry => entry.digest));
  }
  const fetchSeconds = seconds(fetchStart);
  const hydrateStart = performance.now(), store = path.join(cache, 'store');
  if (entries) {
    await pool(entries, concurrency, async entry => {
      assert(entry.path.startsWith('v10/') && !entry.path.split('/').includes('..'));
      const target = path.join(store, entry.path);
      if (entry.path.startsWith('v10/files/') && await exists(target)) return;
      if (entry.path.startsWith('v10/index/')) {
        verify(await fs.readFile(path.join(cache, 'objects', entry.digest)), entry.digest);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(cache, 'objects', entry.digest), target);
      await fs.chmod(target, entry.mode);
    });
    await json(tarballs, []);
  }
  const hydrateSeconds = seconds(hydrateStart);
  const assembly = await run(binary, [
    'assemble', spec.source, out, tarballs,
    ...(entries ? ['--unpacked-store', store] : []),
  ], `${out}.log`);
  return { fetchSeconds, hydrateSeconds, assemblySeconds: assembly.seconds,
    totalSeconds: seconds(started), missingObjects };
}

async function tree(root) {
  const rows = [];
  for (const name of await walk(root)) {
    const file = path.join(root, name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) rows.push([name, 'link', await fs.readlink(file)]);
    else {
      let bytes = await fs.readFile(file);
      // Generated shims and metadata embed the chosen output directory.
      if (bytes.includes(Buffer.from(root))) bytes = Buffer.from(bytes.toString().split(root).join('$OUTPUT'));
      rows.push([name, stat.mode & 0o111, hash(bytes)]);
    }
  }
  return rows;
}

async function benchmark(args) {
  const root = path.resolve(args.out);
  await fs.mkdir(root);
  const beforeRoot = path.resolve(args.before), afterRoot = path.resolve(args.after);
  const before = await readJSON(path.join(beforeRoot, 'spec.json'));
  const after = await readJSON(path.join(afterRoot, 'spec.json'));
  const warmSource = path.join(root, 'source-edit');
  await fs.cp(before.source, warmSource, { recursive: true });
  await write(path.join(warmSource, '.object-store-source-edit'), 'source-only revision\n');
  const warm = { ...before, source: warmSource };
  const runs = Number(args.runs || 5), concurrency = Number(args.concurrency || 32);
  assert(Number.isInteger(runs) && runs > 0 && Number.isInteger(concurrency) && concurrency > 0);
  const report = {
    machine: { cpus: os.cpus().map(cpu => cpu.model), node: process.version, platform: os.platform(),
      cpuLimit: await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
      memoryLimit: await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8') },
    command: process.argv, concurrency, runs, before: before.corpus, after: after.corpus,
    preparation: { before: before.preparation, after: after.preparation },
    scope: 'Loopback HTTP simulator. Added delay per request, no bandwidth cap or TLS. Batch gateway reads local objects. Total includes fetch, validation, hydration and real drvjs assembly. NAR compression is measured separately. Excludes Nix evaluation, import/registration, remote cache publication/substitution and application build. Warm is a real source-only edit.',
    samples: [],
  };
  for (const latency of (args.latencies || '0,20').split(',').map(Number)) {
    assert(Number.isFinite(latency) && latency >= 0);
    const service = await serve([beforeRoot, afterRoot], latency);
    try {
      for (let trial = 0; trial < runs; trial++) {
        const modes = ['tar', 'files', 'batch'];
        const order = modes.slice(trial % 3).concat(modes.slice(0, trial % 3));
        const expected = new Map();
        for (const mode of order) {
          const cache = path.join(root, `cache-${latency}-${trial}-${mode}`);
          for (const scenario of ['cold', 'warm', 'update']) {
            const spec = scenario === 'update' ? after : scenario === 'warm' ? warm : before;
            const output = path.join(root, 'output');
            const prior = { ...service.metrics };
            const result = await install(spec, mode, cache, output, args.binary, service.url, concurrency);
            const sample = { latencyMs: latency, trial, mode, scenario, ...result,
              requests: service.metrics.requests - prior.requests,
              payloadBytes: service.metrics.bytes - prior.bytes };
            const nar = path.join(root, 'output.nar.zst');
            const publication = await run('bash', [
              '-o', 'pipefail', '-c', 'nix-store --dump "$1" | zstd -q -3 -o "$2"', '--', output, nar,
            ]);
            sample.narCompressionSeconds = publication.seconds;
            sample.compressedNarBytes = (await fs.stat(nar)).size;
            sample.throughNarSeconds = result.totalSeconds + publication.seconds;
            await fs.rm(nar);
            const signature = await tree(output);
            if (expected.has(scenario)) assert.deepEqual(signature, expected.get(scenario), `${mode} ${scenario} tree mismatch`);
            else expected.set(scenario, signature);
            sample.verifiedEntries = signature.length;
            report.samples.push(sample);
            await json(path.join(root, 'results.json'), report);
            console.log(JSON.stringify(sample));
            await fs.rm(output, { recursive: true });
          }
          await fs.rm(cache, { recursive: true });
        }
      }
    } finally {
      service.server.closeAllConnections();
      await new Promise(resolve => service.server.close(resolve));
    }
  }
  report.summary = [];
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  };
  for (const key of new Set(report.samples.map(s => `${s.latencyMs}/${s.scenario}/${s.mode}`))) {
    const [latency, scenario, mode] = key.split('/');
    const samples = report.samples.filter(s => s.latencyMs === +latency && s.scenario === scenario && s.mode === mode);
    const row = { latencyMs: +latency, scenario, mode };
    for (const field of ['totalSeconds', 'fetchSeconds', 'hydrateSeconds', 'assemblySeconds', 'narCompressionSeconds', 'throughNarSeconds', 'compressedNarBytes', 'requests', 'payloadBytes', 'missingObjects']) {
      row[field] = median(samples.map(s => s[field]));
    }
    row.minSeconds = Math.min(...samples.map(s => s.totalSeconds));
    row.maxSeconds = Math.max(...samples.map(s => s.totalSeconds));
    report.summary.push(row);
  }
  await json(path.join(root, 'results.json'), report);
  console.log(JSON.stringify(report.summary, null, 2));
}

async function validate(args) {
  const root = path.resolve(args.out), origin = path.resolve(args.before);
  await fs.mkdir(root);
  const spec = await readJSON(path.join(origin, 'spec.json'));
  const poison = path.join(root, 'poison');
  const service = await serve([poison, origin], 0);
  try {
    let expected;
    for (const mode of ['tar', 'files', 'batch']) {
      const cache = path.join(root, mode), output = path.join(root, 'output');
      await install(spec, mode, cache, output, args.binary, service.url, 16);
      const signature = await tree(output);
      if (expected) assert.deepEqual(signature, expected);
      else expected = signature;
      if (mode !== 'tar') {
        await run(args.binary, ['verify', output, '--store', path.join(cache, 'store')], path.join(root, `${mode}-pnpm.log`));
      }
      await fs.rm(output, { recursive: true });
    }
    const index = spec.indexes[0];
    const originalIndex = await unzip(await fs.readFile(path.join(origin, 'objects', index.digest)));
    const info = Object.values(JSON.parse(originalIndex).files)[0];
    const digest = Buffer.from(info.integrity.split('-')[1], 'base64').toString('hex');
    for (const [label, key, modes, expectedError] of [
      ['manifest', `objects/${index.digest}`, ['files', 'batch'], /content digest mismatch/],
      ['content', `objects/${digest}`, ['files', 'batch'], /content digest mismatch/],
      ['archive', spec.archives[0].key, ['tar'], /archive SRI mismatch/],
    ]) {
      await write(path.join(poison, key), await zip(Buffer.from('tampered')));
      for (const mode of modes) {
        const limited = { ...spec, indexes: [index], archives: spec.archives.slice(0, 1) };
        await assert.rejects(
          install(limited, mode, path.join(root, `${label}-${mode}`), path.join(root, 'rejected'), args.binary, service.url, 1),
          expectedError,
        );
      }
      await fs.rm(path.join(poison, key));
    }
    await json(path.join(root, 'validation.json'), {
      matchingEntries: expected.length, offlinePnpm: ['files', 'batch'],
      rejected: ['tampered manifest: files/batch', 'tampered content: files/batch', 'tampered tarball'],
    });
    console.log('PASS: equal installed trees, independent offline pnpm, and five corruption cases');
  } finally {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
  }
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(['binary', 'export', 'out', 'before', 'after', 'runs', 'concurrency', 'latencies']
    .map(key => [key, { type: 'string' }])),
});
assert(args.binary && args.out, '--binary and --out are required');
if (positionals[0] === 'prepare') {
  assert(args.export, '--export is required');
  await prepare(args);
} else if (positionals[0] === 'validate') {
  assert(args.before, '--before is required');
  await validate(args);
} else {
  assert.equal(positionals[0], 'benchmark', 'expected prepare or benchmark');
  assert(args.before && args.after, '--before and --after are required');
  await benchmark(args);
}
