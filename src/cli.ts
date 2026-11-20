#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';
import { ConfigError, loadConfigFile, resolveConfig } from './config.js';
import { runInit } from './init.js';
import type { ProviderName } from './presets.js';
import type { ProfileName } from './profiles.js';
import { startRecorder } from './record.js';
import { formatRunLine, formatSuite, toJson, toJunit } from './report.js';
import { runSuite, seedsFor, UnreachableError } from './runner.js';
import { randomSeed } from './prng.js';
import { VERSION } from './version.js';

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
  return n;
};

async function writeOut(path: string, content: string) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

const program = new Command()
  .name('hookstorm')
  .description('Chaos-test webhook receivers: duplicates, reordering, dropped responses, timeouts.')
  .version(VERSION);

program
  .command('run')
  .description('deliver events with injected faults and check your invariants')
  .option('-c, --config <path>', 'config file', 'hookstorm.config.ts')
  .option('-t, --target <url>', 'override the target URL')
  .option('-s, --seed <n>', 'first seed (default: random)', int('seed'))
  .option('-n, --runs <n>', 'number of seeds to try', int('runs'), 10)
  .addOption(new Option('-p, --profile <name>', 'fault profile').choices(['gentle', 'realistic', 'hostile']))
  .option('--timeout <ms>', 'per-attempt response timeout', int('timeout'))
  .option('--settle <ms>', 'wait before probing state', int('settle'))
  .option('--sink-port <port>', 'sink port', int('sink-port'))
  .option('--json <path>', 'write a JSON report')
  .option('--junit <path>', 'write a JUnit XML report')
  .option('--examples <n>', 'example violations to show per invariant', int('examples'), 1)
  .option('-q, --quiet', 'only print the final report')
  .action(async (opts) => {
    const config = await loadConfigFile(opts.config);
    const cfg = await resolveConfig(config, opts.config, {
      target: opts.target,
      profile: opts.profile as ProfileName | undefined,
      timeoutMs: opts.timeout,
      settleMs: opts.settle,
      sinkPort: opts.sinkPort,
    });
    const base = opts.seed ?? randomSeed();
    const seeds = seedsFor(base, Math.max(1, opts.runs));
    if (!opts.quiet) {
      console.log(
        pc.bold('hookstorm') +
          pc.dim(
            ` v${VERSION} · ${cfg.preset.name} → ${cfg.target} · profile ${cfg.profileName} · ${cfg.events.length} events · ${seeds.length} seed(s) from ${base}`,
          ),
      );
      console.log(pc.dim(`sink listening on http://${cfg.sinkHost}:${cfg.sinkPort}/sink/<effect>\n`));
    }
    const suite = await runSuite(cfg, seeds, {
      onRunEnd: (r, i, total) => {
        if (!opts.quiet) console.log(formatRunLine(r, i, total));
      },
    });
    console.log(formatSuite(suite, { maxExamples: opts.examples }));
    if (opts.json)
      console.log(
        pc.dim(`JSON report: ${await writeOut(opts.json, JSON.stringify(toJson(suite), null, 2))}`),
      );
    if (opts.junit) console.log(pc.dim(`JUnit report: ${await writeOut(opts.junit, toJunit(suite))}`));
    process.exitCode = suite.runs.some((r) => r.fatal) ? 2 : suite.passed ? 0 : 1;
  });

program
  .command('init')
  .description('create hookstorm.config.ts and sample events for a provider')
  .addOption(
    new Option('--provider <name>', 'provider preset')
      .choices(['stripe', 'paystack', 'github', 'custom'])
      .default('stripe'),
  )
  .option('-t, --target <url>', 'your webhook endpoint', 'http://localhost:3000/webhooks')
  .action(async (opts) => {
    const files = await runInit(opts.provider as ProviderName, opts.target);
    for (const f of files) console.log(`${pc.green('created')} ${f}`);
    console.log(
      `\nNext: point your app's side effects at the sink, edit the invariants, then run ${pc.bold('hookstorm run')}`,
    );
  });

program
  .command('record')
  .description('record real test-mode webhooks into a JSONL fixture (optionally forwarding to your app)')
  .addOption(
    new Option('--provider <name>', 'provider preset')
      .choices(['stripe', 'paystack', 'github', 'custom'])
      .makeOptionMandatory(),
  )
  .option('--port <port>', 'port to listen on', int('port'), 4500)
  .option('--forward <url>', 'forward each request, unchanged, to your app')
  .option('-o, --out <path>', 'fixture file to append to', 'hookstorm.events.jsonl')
  .action(async (opts) => {
    const rec = await startRecorder({
      provider: opts.provider as ProviderName,
      port: opts.port,
      forward: opts.forward,
      out: resolve(opts.out),
      log: (l) => console.log(l),
    });
    console.log(`${pc.bold('hookstorm record')} listening on ${rec.url} → ${resolve(opts.out)}`);
    if (opts.forward) console.log(pc.dim(`forwarding to ${opts.forward}`));
    if (opts.provider === 'stripe') console.log(pc.dim(`e.g. stripe listen --forward-to ${rec.url}`));
    console.log(pc.dim('Ctrl+C to stop'));
    process.on('SIGINT', () => void rec.close().then(() => process.exit(0)));
  });

program.parseAsync().catch((err: unknown) => {
  const e = err as Error;
  console.error(
    pc.red(
      `hookstorm: ${e instanceof ConfigError || e instanceof UnreachableError ? e.message : (e.stack ?? e.message)}`,
    ),
  );
  process.exitCode = 2;
});
