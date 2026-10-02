import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreCase, validateTarget } from './qualification-score.mjs';

export const ALLOWED_MODES = new Set(['metadata', 'deep', 'deep-whole']);
export const ALLOWED_COHORTS = new Set(['development', 'evaluation']);
const SHA256 = /^[a-f0-9]{64}$/;
const CASE_ID = /^[a-z0-9-]+$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a nonempty string`);
  return value;
};
const requireSha256 = (value, label) => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw Error(`${label} must be a lowercase SHA-256 hex string`);
  return value;
};
const requirePositiveSafeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`${label} must be a positive safe integer`);
  return value;
};

export function parseRunPolicy(cohortArg = 'development', repetitionsArg = '2') {
  if (!ALLOWED_COHORTS.has(cohortArg)) throw Error('Invalid cohort');
  if (typeof repetitionsArg !== 'string' || !/^(?:[1-9]|10)$/.test(repetitionsArg)) throw Error('Invalid repetitions');
  const repetitions = Number(repetitionsArg);
  if (!Number.isSafeInteger(repetitions)) throw Error('Invalid repetitions');
  return { cohort: cohortArg, repetitions };
}

export function validatePlan(plan, cohort) {
  if (!isObject(plan) || plan.version !== 1 || !Array.isArray(plan.cases) || !plan.cases.length) throw Error('Plan must be version 1 with a nonempty cases array');
  const ids = new Set();
  for (const [index, entry] of plan.cases.entries()) {
    const label = `plan.cases[${index}]`;
    if (!isObject(entry) || !CASE_ID.test(entry.id ?? '')) throw Error(`${label}.id is invalid`);
    if (ids.has(entry.id)) throw Error(`Duplicate plan case id: ${entry.id}`);
    ids.add(entry.id);
    if (!ALLOWED_COHORTS.has(entry.cohort)) throw Error(`${label}.cohort is invalid`);
    requireString(entry.input, `${label}.input`);
    requireSha256(entry.inputSha256, `${label}.inputSha256`);
    requirePositiveSafeInteger(entry.size, `${label}.size`);
    if (!Array.isArray(entry.modes) || !entry.modes.length) throw Error(`${label}.modes must be nonempty`);
    const modes = new Set(entry.modes);
    if (modes.size !== entry.modes.length || [...modes].some(mode => !ALLOWED_MODES.has(mode))) throw Error(`${label}.modes contains an unsupported or duplicate mode`);
  }
  const selected = plan.cases.filter(entry => entry.cohort === cohort);
  if (!selected.length) throw Error(`Plan contains no ${cohort} cases`);
  return selected;
}

export function validateOracle(oracle, plan, selectedCases) {
  if (!isObject(oracle) || oracle.version !== 1 || !Array.isArray(oracle.cases) || !oracle.cases.length) throw Error('Oracle must be version 1 with a nonempty cases array');
  const planById = new Map(plan.cases.map(entry => [entry.id, entry]));
  const oracleById = new Map();
  for (const [index, answer] of oracle.cases.entries()) {
    const label = `oracle.cases[${index}]`;
    if (!isObject(answer) || !CASE_ID.test(answer.id ?? '')) throw Error(`${label}.id is invalid`);
    if (oracleById.has(answer.id)) throw Error(`Duplicate oracle case id: ${answer.id}`);
    const entry = planById.get(answer.id);
    if (!entry) throw Error(`Oracle case does not exist in plan: ${answer.id}`);
    requireSha256(answer.sourceSha256, `${label}.sourceSha256`);
    if (answer.sourceSha256 !== entry.inputSha256) throw Error(`Oracle/image mismatch for ${answer.id}`);
    if (!Array.isArray(answer.targets) || !answer.targets.length) throw Error(`${label}.targets must be nonempty`);
    if (answer.synthetic === true) {
      if (answer.cohort !== entry.cohort || typeof answer.layout !== 'string' || !answer.layout.trim()) throw Error(`${label} synthetic fields are invalid`);
    } else if (answer.synthetic !== undefined && typeof answer.synthetic !== 'boolean') {
      throw Error(`${label}.synthetic must be boolean when supplied`);
    }
    const modes = new Set(entry.modes), targetIds = new Set();
    for (const [targetIndex, target] of answer.targets.entries()) {
      validateTarget(target, modes, `${label}.targets[${targetIndex}]`);
      if (targetIds.has(target.id)) throw Error(`Duplicate target id in ${answer.id}: ${target.id}`);
      targetIds.add(target.id);
    }
    oracleById.set(answer.id, answer);
  }
  for (const entry of selectedCases) if (!oracleById.has(entry.id)) throw Error(`No oracle entry for selected case: ${entry.id}`);
  return oracleById;
}

// This intentionally has only worker, engine root, image, mode, and output. Oracle data never becomes child input.
export function workerArgv(worker, engineRoot, input, mode, directory) {
  const args = [worker, engineRoot, input, mode, directory];
  if (args.length !== 5 || args.some(value => typeof value !== 'string' || !value)) throw Error('Invalid engine worker arguments');
  if (!ALLOWED_MODES.has(mode)) throw Error('Unexpected mode');
  return args;
}

const hashFile = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };

export async function main(argv = process.argv.slice(2)) {
  const [planArg, oracleArg, engineArg, outputArg, cohortArg = 'development', repetitionsArg = '2'] = argv;
  if (![planArg, oracleArg, engineArg, outputArg].every(Boolean)) throw Error('plan oracle engineRoot outputRoot [cohort] [repetitions] required');
  const { cohort, repetitions } = parseRunPolicy(cohortArg, repetitionsArg);
  const plan = JSON.parse(await readFile(planArg, 'utf8'));
  const selectedCases = validatePlan(plan, cohort);
  const output = path.resolve(outputArg), engineRoot = path.resolve(engineArg);
  await mkdir(output);
  const engineHashes = {};
  for (const file of (await readdir(path.join(engineRoot, 'engine'))).filter(name => name.endsWith('.mjs')).sort()) engineHashes[file] = await hashFile(path.join(engineRoot, 'engine', file));
  const packageInfo = await readFile(path.join(engineRoot, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return { version: 'unavailable-in-unpacked-engine' };
    throw error;
  });
  const config = { engineRoot, version: packageInfo.version, engineHashes, node: process.version, cohort, repetitions, sourcePlan: path.resolve(planArg), planSha256: await hashFile(planArg), startedAt: new Date().toISOString() };
  config.harnessHashes = {};
  for (const name of ['qualification-worker.mjs', 'qualification-score.mjs', 'verify-stage3.mjs']) config.harnessHashes[name] = await hashFile(fileURLToPath(new URL(name, import.meta.url)));
  await writeFile(path.join(output, 'configuration.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
  const executions = [];
  for (const entry of selectedCases) for (let repetition = 1; repetition <= repetitions; repetition++) for (const mode of entry.modes) {
    const directory = path.join(output, `${entry.id}-${mode}-${repetition}`);
    const beforeHash = await hashFile(entry.input);
    if (beforeHash !== entry.inputSha256 || (await stat(entry.input)).size !== entry.size) throw Error('Input image changed before execution');
    await mkdir(directory);
    const worker = fileURLToPath(new URL('./qualification-worker.mjs', import.meta.url));
    const started = Date.now(); let log = '';
    const exit = await new Promise(resolve => {
      const child = spawn(process.execPath, workerArgv(worker, engineRoot, path.resolve(entry.input), mode, directory), { windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory } });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
      child.stdout.on('data', buffer => { log += buffer.toString(); }); child.stderr.on('data', buffer => { log += buffer.toString(); });
      child.on('error', error => { log += error.message; }); child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut }); });
    });
    await writeFile(path.join(directory, 'worker.log'), log, { flag: 'wx' });
    const afterHash = await hashFile(entry.input);
    let result = null, resultHash = null;
    try { result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); resultHash = await hashFile(path.join(directory, 'result.json')); } catch {}
    const canonical = await realpath(directory);
    for (const file of result?.outputs ?? []) {
      const resolved = await realpath(file.path), relative = path.relative(canonical, resolved);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Output escaped worker directory');
      if ((await stat(resolved)).size !== file.size || await hashFile(resolved) !== file.sha256) throw Error('Output changed before freeze');
    }
    const receipt = { caseId: entry.id, mode, repetition, directory, beforeHash, afterHash, unchanged: beforeHash === afterHash, resultHash, exit, elapsedMs: Date.now() - started, outputsFrozenAt: new Date().toISOString() };
    await writeFile(path.join(directory, 'freeze.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    executions.push(receipt);
    await writeFile(path.join(output, 'progress.json'), JSON.stringify({ completed: executions.length, executions }, null, 2));
    console.log(JSON.stringify({ caseId: entry.id, mode, repetition, exit: exit.code, outputs: result?.outputs.length ?? 0 }));
  }
  // The first oracle read is deliberately after every engine execution and freeze above.
  const oracle = JSON.parse(await readFile(oracleArg, 'utf8'));
  const oracleById = validateOracle(oracle, plan, selectedCases);
  const scored = [];
  for (const execution of executions) {
    const answer = oracleById.get(execution.caseId);
    const passedExecution = execution.exit.code === 0 && !execution.exit.timedOut && execution.unchanged && execution.resultHash;
    let rows = [];
    if (passedExecution) {
      const file = path.join(execution.directory, 'result.json');
      if (await hashFile(file) !== execution.resultHash) throw Error('Result changed after freeze');
      rows = scoreCase(answer, JSON.parse(await readFile(file, 'utf8')), execution.mode);
    }
    scored.push({ ...execution, status: passedExecution ? 'scored' : 'execution-failed', rows, passed: !!passedExecution && rows.every(row => row.pass) });
  }
  const rows = scored.flatMap(score => score.rows), repeated = [];
  for (const entry of selectedCases) for (const mode of entry.modes) {
    const trials = scored.filter(score => score.caseId === entry.id && score.mode === mode);
    const normalized = trials.map(trial => JSON.stringify(trial.rows.map(({ id, exact, metadataFound, wrongBodySaved, pass }) => ({ id, exact, metadataFound, wrongBodySaved, pass }))));
    repeated.push({ caseId: entry.id, mode, repetitions: trials.length, matches: trials.length === repetitions && trials.every(trial => trial.status === 'scored') && new Set(normalized).size === 1 });
  }
  const report = { ...config, finishedAt: new Date().toISOString(), oracleReadAfterAllEngineExecutions: true, oracleSha256: await hashFile(oracleArg),
    summary: { executions: scored.length, failedExecutions: scored.filter(score => score.status !== 'scored').length, evaluatedRows: rows.length, positiveRows: rows.filter(row => row.expectedExact).length, positiveExact: rows.filter(row => row.expectedExact && row.exact).length, totalExact: rows.filter(row => row.exact).length, failedExpectations: rows.filter(row => !row.pass).length, unexpectedOriginalClaims: rows.filter(row => row.unexpectedOriginalClaim).length, repeatedResultsMatch: repeated.every(row => row.matches) }, repeated, scored,
    limits: ['Synthetic and public fixed images are not a live SSD recovery rate', 'Byte-exact scores do not establish application opening unless separately checked', 'Oracle-free execution is enforced by process arguments and reviewed code, not an OS read-access sandbox'] };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report.summary));
  if (report.summary.failedExecutions || report.summary.failedExpectations || !report.summary.repeatedResultsMatch) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
