#!/usr/bin/env node
/**
 * Validator dev CLI: run the CREATE / UPDATE validation decision pipeline
 * offline against a read-only SRU endpoint and print the decision trace
 * (dry-run import decisions: "what would the production pipeline decide for
 * this record?").
 *
 * Usage:
 *   node src/cli.js record.json --sru-url https://sru.api.melinda.kansalliskirjasto.fi/bib/prv
 *   node src/cli.js record.json --sru-url ... --merge on --match-failures-as-new 1 -o trace.json
 *
 * - Input: one record JSON in internal MarcRecord format ({leader, fields})
 *   (same shape as used in validations.test.js / the importer's processLoad).
 * - Live dependency: read-only SRU ONLY (candidate searches + rec.id
 *   getRecord of the target record on the merge and UPDATE paths). No Mongo,
 *   no AMQP, no Aleph writes.
 * - Exit codes: 0 when the pipeline reaches a decision (create / merge /
 *   skip / 409 conflict / validation failed), 1 on CLI usage errors or
 *   pipeline errors.
 *
 * Note: src/config.js reads env vars at module load. The CLI applies its
 * options to process.env BEFORE importing config.js, so within one process
 * the config reflects the first runCli() invocation only.
 */
/* eslint-disable no-console */
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

import {isValidAlephId, getRecordMetadata} from './utils.js';

export const USAGE = `Usage: melinda-validator-cli <record.json> [options]

Runs the validator's decision pipeline offline against a read-only SRU
endpoint and prints the decision trace. The CREATE operation runs the match
chain -> matchValidation -> match selector -> merge / update validations; the
UPDATE operation runs the update validations against the target record.

Options:
  --sru-url <url>                  SRU endpoint (or env SRU_URL). Required.
  --operation CREATE|UPDATE        Operation to probe (default: CREATE)
  --target-id <id>                 Target record id, required with --operation UPDATE
                                   (9-digit Aleph id; must match the record's 001 if present)
  --match-packages <a,b,c>         Match packages to run
                                   (default: env VALIDATOR_MATCH_PACKAGES or IDS,STANDARD_IDS,CONTENTALT)
  --merge on|off                   Run the merge path when matches are found (default: off)
  --match-failures-as-new 0|1      Treat matchValidation failures as new record
                                   (default: env MATCH_FAILURES_AS_NEW or 0)
  --match-selector-rules <a,b,c>   Match selector rules, in priority order
                                   (default: env MATCH_SELECTOR_RULES or all seven rules)
  -o, --output <file>              Write the full trace as JSON to <file>
  -h, --help                       Show this help

Record input: one record JSON in internal MarcRecord format ({leader, fields}).
Only RECORD_TYPE=bib is supported. Read-only SRU traffic only (no Mongo / AMQP / Aleph).
Exit codes: 0 = decision reached (create / merge / update / skip / 409 conflict / validation failed), 1 = error.`;

class CliError extends Error { }

export function parseArgs(argv) {
  const args = {
    recordFile: undefined,
    sruUrl: undefined,
    matchPackages: undefined,
    operation: 'CREATE',
    targetId: undefined,
    merge: 'off',
    matchFailuresAsNew: undefined,
    matchSelectorRules: undefined,
    output: undefined,
    help: false
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const next = () => {
      const value = argv[i += 1];
      if (value === undefined) {
        throw new CliError(`Missing value for ${arg}`);
      }
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-o' || arg === '--output') {
      args.output = next();
    } else if (arg === '--sru-url') {
      args.sruUrl = next();
    } else if (arg === '--operation') {
      args.operation = parseOperation(arg, next());
    } else if (arg === '--target-id') {
      args.targetId = next();
    } else if (arg === '--match-packages') {
      args.matchPackages = next();
    } else if (arg === '--merge') {
      args.merge = parseOnOff(arg, next());
    } else if (arg === '--match-failures-as-new') {
      args.matchFailuresAsNew = parseZeroOne(arg, next());
    } else if (arg === '--match-selector-rules') {
      args.matchSelectorRules = next();
    } else if (arg.startsWith('-')) {
      throw new CliError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    throw new CliError(`Expected exactly one record file, got ${positionals.length}. See --help.`);
  }
  args.recordFile = positionals[0];

  if (args.operation === 'UPDATE') {
    if (!args.targetId) {
      throw new CliError('--operation UPDATE requires --target-id <id>');
    }
    if (!isValidAlephId(args.targetId)) {
      throw new CliError(`Invalid --target-id: ${args.targetId} (expected a 9-digit Aleph id)`);
    }
    const f001 = getRecord001(args.recordFile);
    if (f001 !== undefined && f001 !== args.targetId) {
      throw new CliError(`--target-id ${args.targetId} does not match the record's 001 (${f001})`);
    }
  }
  return args;
}

function parseOnOff(flag, value) {
  if (value === 'on' || value === 'off') {
    return value;
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use on|off)`);
}

function parseZeroOne(flag, value) {
  if (value === '0' || value === '1') {
    return value === '1';
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use 0|1)`);
}

function parseOperation(flag, value) {
  if (value === 'CREATE' || value === 'UPDATE') {
    return value;
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use CREATE|UPDATE)`);
}

// Read the 001 value from the record file for the UPDATE --target-id mismatch check
function getRecord001(recordFile) {
  const recordObject = JSON.parse(readFileSync(recordFile, 'utf8'));
  const f001 = (recordObject.fields ?? []).find(field => field.tag === '001');
  return f001 ? f001.value : undefined;
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    return {args, trace: null, exitCode: 0};
  }

  const sruUrl = args.sruUrl ?? process.env.SRU_URL;
  if (!sruUrl) {
    throw new CliError('No SRU endpoint given: use --sru-url <url> or set env SRU_URL');
  }

  applyCliEnv(args, sruUrl);

  const {validatorOptions, validationsFactory, MarcRecord, fixRecord} = await loadValidator();
  const trace = await runPipeline({args, sruUrl, validatorOptions, validationsFactory, MarcRecord, fixRecord});
  return {args, trace, exitCode: trace.exitCode};
}

// Apply CLI options to env BEFORE config.js is imported (it reads env at module load)
function applyCliEnv(args, sruUrl) {
  process.env.SRU_URL = sruUrl;
  process.env.RECORD_TYPE = process.env.RECORD_TYPE || 'bib';
  if (process.env.RECORD_TYPE !== 'bib') {
    throw new CliError(`Only RECORD_TYPE=bib is supported (got ${process.env.RECORD_TYPE})`);
  }
  if (args.matchPackages) {
    process.env.VALIDATOR_MATCH_PACKAGES = args.matchPackages;
  }
  if (args.matchSelectorRules) {
    process.env.MATCH_SELECTOR_RULES = args.matchSelectorRules;
  }
  // CLI always wants the matcher stage reports, also for zero-match records
  process.env.LOG_NO_MATCHES = process.env.LOG_NO_MATCHES || '1';
  // Keep the trace output clean: suppress library log noise by default (override with env LOG_LEVEL)
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
}

async function loadValidator() {
  const [{validatorOptions}, {validationsFactory}, {MarcRecord}, {fixes}] = await Promise.all([
    import('./config.js'),
    import('./interfaces/validator/validations.js'),
    import('@natlibfi/marc-record'),
    import('@natlibfi/melinda-rest-api-commons')
  ]);
  return {validatorOptions, validationsFactory, MarcRecord, fixRecord: fixes.fixRecord};
}

async function runPipeline({args, sruUrl, validatorOptions, validationsFactory, MarcRecord, fixRecord}) {
  const recordObject = JSON.parse(readFileSync(args.recordFile, 'utf8'));

  // Production processLoad path: MarcRecord(fixRecord(data, preValidationFixOptions), {subfieldValues: false})
  const fixedRecordObject = await fixRecord(recordObject, validatorOptions.preValidationFixOptions);
  const record = new MarcRecord(fixedRecordObject, {subfieldValues: false});

  // No-op capturing mongoLogOperator (pattern from validations.test.js): the only
  // live dependency of the pipeline is SRU, Mongo/AMQP/Aleph are not needed
  const logItems = [];
  const mongoLogOperator = {
    addLogItem(item) {logItems.push(item);},
    removeBySequences() {}
  };

  // no sruClient/matchers injected -> factory builds the real ones from validatorOptions
  const {createValidations, updateValidations} = await validationsFactory(mongoLogOperator, fixRecord, validatorOptions, {});

  const operation = args.operation;
  const merge = args.merge === 'on';
  const operationSettings = {validate: false, unique: true, merge};
  if (args.matchFailuresAsNew !== undefined) {
    operationSettings.matchFailuresAsNew = args.matchFailuresAsNew;
  }

  // Production fills recordMetadata from the record (all sourceIds for CREATE,
  // the first/best set for UPDATE); the CLI supplies only the blobSequence
  const recordMetadata = getRecordMetadata({record, recordMetadata: {blobSequence: 1}, getAllSourceIds: operation === 'CREATE'});

  const headers = {
    correlationId: `validator-cli-${Date.now()}`,
    operation,
    cataloger: {id: 'VALIDATOR_CLI'},
    recordMetadata,
    operationSettings
  };
  if (operation === 'UPDATE') {
    headers.id = args.targetId;
  }

  try {
    const {result, headers: outHeaders} = operation === 'UPDATE'
      ? await updateValidations({updateId: args.targetId, updateRecord: record, updateOperation: 'UPDATE', headers})
      : await createValidations({record, headers});
    // Production throws 422 for a failed validationService result; below the interface
    // layer the same result is reachable, so surface it as a decision
    const outcome = result.failed ? classifyFailed(result) : classifySuccess(outHeaders, operation);
    return buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome, outHeaders});
  } catch (err) {
    return buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome: classifyError(err), outHeaders: null});
  }
}

function buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome, outHeaders}) {
  const matchLog = logItems.find(item => item.logItemType === 'MATCH_LOG');
  const mergeLog = logItems.find(item => item.logItemType === 'MERGE_LOG');
  const exitCode = ['create', 'merge', 'skip', 'conflict', 'update', 'failed'].includes(outcome.kind) ? 0 : 1;
  return {
    recordFile: args.recordFile,
    sruUrl,
    options: {
      operation: args.operation,
      targetId: args.targetId,
      merge,
      matchFailuresAsNew: args.matchFailuresAsNew,
      matchPackages: validatorOptions.matchOptionsList.map(o => o.matchPackageName),
      matchSelectorRules: validatorOptions.matchSelectorRules,
      stopWhenFound: validatorOptions.stopWhenFound,
      acceptZeroWithMaxCandidates: validatorOptions.acceptZeroWithMaxCandidates,
      thresholds: validatorOptions.matchOptionsList.map(o => o.detection.treshold)
    },
    matcherReports: matchLog ? matchLog.matcherReports : [],
    candidates: (matchLog ? matchLog.matchResult : []).map(summarizeCandidate),
    merge: mergeLog ? {
      databaseId: mergeLog.databaseId,
      preference: mergeLog.preference,
      mergedRecord: mergeLog.mergedRecord.toObject()
    } : null,
    outcome,
    headers: outHeaders,
    exitCode
  };
}

function summarizeCandidate(match) {
  return {
    id: match.candidate.id,
    probability: match.probability,
    matchSequence: match.matchSequence,
    action: match.action,
    preference: match.preference,
    message: match.message,
    matchers: (match.matcherReports ?? []).map(r => ({matcherSequence: r.matcherSequence, matcherName: r.matcherName, matchStatus: r.matchStatus}))
  };
}

function classifySuccess(outHeaders, requestedOperation) {
  const {operation, id, notes} = outHeaders;
  if (operation === 'UPDATE') {
    // An out-header UPDATE from a CREATE entry means the record was merged into a
    // candidate; a direct UPDATE probe keeps the UPDATE operation
    return {kind: requestedOperation === 'UPDATE' ? 'update' : 'merge', operation, id, notes: notes ?? []};
  }
  if (operation === 'SKIPPED_UPDATE' || operation === 'SKIPPED_CHANGE') {
    return {kind: 'skip', operation, id, notes: notes ?? []};
  }
  return {kind: 'create', operation, notes: notes ?? []};
}

function classifyFailed(result) {
  return {kind: 'failed', status: 422, messages: result.messages ?? []};
}

function classifyError(err) {
  if (err.status === 409) {
    return {kind: 'conflict', status: err.status, message: err.payload?.message, ids: err.payload?.ids ?? []};
  }
  return {kind: 'error', status: err.status, message: err.payload?.message ?? err.message};
}

export function printTrace(trace) {
  const {options} = trace;
  console.log(`Record:    ${trace.recordFile}`);
  console.log(`SRU:       ${trace.sruUrl}`);
  console.log(`Options:   operation=${options.operation}${options.targetId ? ` targetId=${options.targetId}` : ''} merge=${options.merge} matchFailuresAsNew=${options.matchFailuresAsNew ?? 'config-default'} packages=${options.matchPackages.join(',')} selectorRules=${options.matchSelectorRules.join(',')} stopWhenFound=${options.stopWhenFound} thresholds=${JSON.stringify(options.thresholds)}`);
  console.log('');
  console.log(`Matcher stages (${trace.matcherReports.length}):`);
  for (const report of trace.matcherReports) {
    console.log(`  #${report.matcherSequence} ${report.matcherName}: matches=${report.matchAmount} ids=${JSON.stringify(report.matchIds ?? [])} candidates=${report.candidateCount ?? 'n/a'} conversionFailures=${report.conversionFailureCount ?? 'n/a'} status=${JSON.stringify(report.matchStatus ?? {})}`);
    if (report.matcherErrored) {
      console.log(`    ERRORED: ${report.matcherError}`);
    }
  }
  console.log('');
  console.log(`Candidates (${trace.candidates.length}):`);
  for (const candidate of trace.candidates) {
    console.log(`  ${candidate.id} probability=${candidate.probability} matchSequence=${candidate.matchSequence} action=${JSON.stringify(candidate.action)} preference=${JSON.stringify(candidate.preference)}${candidate.message ? ` message=${candidate.message}` : ''}`);
  }
  if (trace.merge) {
    console.log('');
    console.log(`Merged into ${trace.merge.databaseId} (preference ${JSON.stringify(trace.merge.preference)})`);
  }
  console.log('');
  console.log(`Decision: ${describeDecision(trace.outcome)}`);
  if (trace.outcome.kind === 'failed') {
    for (const message of trace.outcome.messages) {
      console.log(`  ${message.description}: ${message.messages?.join('; ') ?? 'invalid'}`);
    }
  }
}

function describeDecision(outcome) {
  switch (outcome.kind) {
    case 'create':
      return 'CREATE (new record)';
    case 'update':
      return `UPDATE ${outcome.id}`;
    case 'failed':
      return 'VALIDATION FAILED (422 in production)';
    case 'merge':
      return `MERGE -> UPDATE into ${outcome.id} (${lastNote(outcome.notes) ?? 'merged'})`;
    case 'skip':
      return `${outcome.operation} (skip)${outcome.id ? ` into ${outcome.id}` : ''}: ${lastNote(outcome.notes) ?? 'skipped'}`;
    case 'conflict':
      return `409 CONFLICT: ${outcome.message}${outcome.ids.length ? ` (ids: ${outcome.ids.join(', ')})` : ''}`;
    default:
      return `${outcome.kind.toUpperCase()}: ${outcome.message ?? ''}${outcome.status ? ` (status ${outcome.status})` : ''}`;
  }
}

function lastNote(notes) {
  return notes.length > 0 ? notes[notes.length - 1] : undefined;
}

async function main() {
  try {
    const {args, trace, exitCode} = await runCli(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      process.exitCode = 0;
      return;
    }
    printTrace(trace);
    if (args.output) {
      writeFileSync(args.output, `${JSON.stringify(trace, null, 2)}\n`);
      console.log(`\nTrace written to ${args.output}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    console.error(`validator-cli error: ${err.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
