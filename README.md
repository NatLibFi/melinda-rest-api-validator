# Service for validating and queuing import records from melinda-rest-api
![Version](https://img.shields.io/github/package-json/v/NatLibFi/melinda-rest-api-validator.svg)
![Node Version](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fraw.githubusercontent.com%2FNatLibFi%2Fmelinda-rest-api-validator%2Fmaster%2Fpackage.json&label=node&query=$.engines.node)

## Compatibility
This version targets the current house component line: `@natlibfi/melinda-rest-api-commons` 6.2.x,
`@natlibfi/melinda-commons` 16, `@natlibfi/marc-record` 11, Node ≥24.
Pre-release (alpha) versions are for test/staging use only; the stable release comes when all dependencies are stable.

## Usage
While service is in operation:

- if `'POLL_REQUEST'` is true, service will poll `'REQUEST'` AMQP queue for a **prio** job. It will validate the incoming record, send the validated record to the job's `operation.correlationId` AMQP queue and transition the job state to `'IMPORTER.IN_QUEUE'` in Mongo.

- if `'POLL_REQUEST'` is false, service will poll Mongo to find a **bulk** job in state `'VALIDATOR.PENDING_QUEUING'`. It will stream the jobs content from Mongo bucket and transform it to records, send the records to the job's `operation.correlationId` AMQP queue and transition the job state to `'IMPORTER.IN_QUEUE'` in Mongo.

### Environment variables
| Name                 | Mandatory | Description                                                                                                        |
|----------------------|-----------|--------------------------------------------------------------------------------------------------------------------|
| AMQP_URL             | Yes       | A serialized object of AMQP connection config                                                                      |
| SRU_URL              | Yes       | A serialized URL address to SRU                                                                                     |
| MONGO_URI            | No        | A serialized URL address of Melinda-rest-api's import queue database. Defaults to `'mongodb://localhost:27017/db'` |
| OFFLINE_PERIOD       | No        | Starting hour and length of offline period. e.g `'11,1'`                                                           |
| POLL_REQUEST         | No        | A numeric presentation of boolean option to start polling AMQP `'REQUEST'` queue when process is started e.g. `1`  |
| POLL_WAIT_TIME       | No        | A number value presenting time in ms between polling. Defaults to `'1000'`                                         |
| FAIL_BULK_ON_ERROR   | No        | A numeric presentation of boolean option to fail whole bulk, if reading payload to records errors. Defaults to `true`. |
| KEEP_SPLITTER_REPORT | No        | When to keep information about bulk payload splitting process in the queueItem. Options `ALL/NONE/ERROR`. Defaults to `ERROR`. |
| LOG_LEVEL            | No        | Log information level                                                                                              |
| RECORD_TYPE          | Yes       | `bib` |
| DEBUG                | No        | Debug setting |
| VALIDATOR_MATCH_PACKAGES | No    | Defaults to `IDS,STANDARD_IDS,CONTENT`. |
| STOP_WHEN_FOUND      | No        | A numeric presentation of boolean option to stop iterating matchers when a match is found. Defaults to `true`.  |
| ACCEPT_ZERO_WITH_MAX_CANDIDATES | No | A numeric presentation of boolean option to accept zero matches result without erroring when matchStatus is false and stopReason is maxCandidates. Defaults to `false`. |
| MATCH_FAILURES_AS_NEW | No | A numeric presentation of boolean option to handle a matching result where all matches fail matchValidation as a no-match matching result. This setting can be overridden by a job's operationSettings.matchFailuresAsNew. Defaults to `false`. |
| LOG_NO_MATCHES | No | A numeric presentation of boolean option to keep MATCH_LOG logItems also when record did not find any matches. Defaults to `false`. |
| LOG_INPUT_RECORD | No | A numeric presentation of boolean option to log incoming record in INPUT_RECORD_LOG logItem. Defaults to `false`. Note: logItems are not kept for records that end up with any of SKIPPED -recordStatuses.|
| LOG_RESULT_RECORD | No | A numeric presentation of boolean option to log result record (that is/would be saved to database) in RESULT_RECORD_LOG logItem. Defaults to `false`. Note: logItems are not kept for records that end up with any of SKIPPED -recordStatuses. |





### Mongo

Db: `'rest-api'`
Collections: `'prio'`, `'bulk'`, `'logs'`

Queue-item schema example for a prio job queueItem:
```json
{
"correlationId":"FOO",
"cataloger":"xxx0000",
"oCatalogerIn": "xxx0000",
"operation":"UPDATE",
"operationSettings": {
  "noop": true,
  "unique": false,
  "prio": true,
  },
"recordLoadParams": {
  "pActiveLibrary": "XXX00",
  "pInputFile": "filename.seq",
  "pRejectFile": "filename.rej",
  "pLogFile": "filename.syslog",
  "pOldNew": "NEW"
  },
"queueItemState":"DONE",
"creationTime":"2020-01-01T00:00:00.000Z",
"modificationTime":"2020-01-01T00:00:01.000Z",
"handledIds": [ "000000001"],
"rejectedIds": [],
"errorStatus": "",
"errorMessage": "",
"noopValidationMessages": [],
"loadProcessReports": []
}
```

Queue-item schema examle for a bulk job queueItem:
```json
{
"correlationId":"FOO",
"cataloger":"xxx0000",
"oCatalogerIn": "xxx0000",
"operation":"UPDATE",
"operationSettings": {
  "prio": false,
 },
"contentType": "application/json",
"recordLoadParams": {
  "pActiveLibrary": "XXX00",
  "pInputFile": "filename.seq",
  "pRejectFile": "filename.rej",
  "pLogFile": "filename.syslog",
  "pOldNew": "NEW"
},
"queueItemState":"DONE",
"creationTime":"2020-01-01T00:00:00.000Z",
"modificationTime":"2020-01-01T00:00:01.000Z",
"handledIds": [ "000000001","000000002"],
"rejectedIds": ["000999999"],
"errorStatus": "",
"errorMessage": "",
"loadProcessReports": [{
  "status": 200,
  "processId": 9999,
  "processedAll": false,
  "recordAmount": 3,
  "processedAmount": 2,
  "handledAmount": 1,
  "rejectedAmount": 1,
  "rejectMessages": ["Cannot overwrite a deleted record. Record 000999999 is written to rej file"]
  }],
"splitterReport": [{
  "recordNumber": 0,
  "sequenceNumber": 2,
  "readerErrors": [{
    "sequenceNumber": 1,
    "error": "Record is invalid"
  }]
 }]
}
```

## Dev CLI

The package installs a `melinda-validator-cli` binary that runs the validator's
**CREATE decision pipeline** (match chain -> match validation -> match selector
-> merge / update validations) offline against a read-only SRU endpoint, and
prints the decision trace: "what would the production pipeline decide for this
record?"

It performs no writes. It uses no Mongo, no AMQP and no Aleph access; the only
live dependency is read-only SRU traffic (candidate searches, plus a `getRecord`
fetch of the match target on the merge path).

### Usage

```sh
melinda-validator-cli <record.json> --sru-url https://sru.api.melinda.kansalliskirjasto.fi/bib/prv [--options]
```

| Option                 | Description                                                                                          |
|------------------------|------------------------------------------------------------------------------------------------------|
| `--sru-url <url>`      | SRU endpoint. Mandatory, unless the `SRU_URL` environment variable is set.                            |
| `--match-packages <a,b,c>` | Match packages to run. Defaults to the `VALIDATOR_MATCH_PACKAGES` environment variable, or `IDS,STANDARD_IDS,CONTENTALT`. |
| `--merge on\|off`      | Run the merge path when matches are found. Defaults to `off` (report the conflict instead of merging). |
| `--match-failures-as-new 0\|1` | Treat a result where all matches fail match validation as a no-match result. Defaults to the `MATCH_FAILURES_AS_NEW` environment variable, or `0`. |
| `--match-selector-rules <a,b,c>` | Match selection rules, in priority order. Defaults to the `MATCH_SELECTOR_RULES` environment variable, or all rules. |
| `-o, --output <file>`  | Write the full trace as JSON to `<file>`.                                                             |
| `-h, --help`           | Show the option reference.                                                                            |

**Input**: one record JSON file in the internal `MarcRecord` format
(`{leader, fields}`). Only `RECORD_TYPE=bib` is supported, and only the CREATE
operation.

**Output**: a human-readable trace on stdout — the effective options, per-stage
matcher reports, one line per candidate (id, probability, match validation
action and preference), the merge target if one is chosen, and a final
`Decision:` line (`CREATE`, `MERGE` into an id, `SKIPPED_*`, or `409 CONFLICT`
with the candidate ids). With `-o`, the same trace is written as JSON.

**Exit codes**: `0` when the pipeline reaches any decision (create / merge /
skip / 409 conflict); `1` on CLI usage errors or pipeline errors.

Run `melinda-validator-cli --help` for the authoritative option reference.

## License and copyright

Copyright (c) 2020-2026 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **MIT** or any later version.
