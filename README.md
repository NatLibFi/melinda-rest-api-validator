# Service for validating and queuing import records from melinda-rest-api
![Version](https://img.shields.io/github/package-json/v/NatLibFi/melinda-rest-api-validator.svg)
![Node Version](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fraw.githubusercontent.com%2FNatLibFi%2Fmelinda-rest-api-validator%2Fmaster%2Fpackage.json&label=node&query=$.engines.node)

## Usage
While service is in operation:

- if `'POLL_REQUEST'` is true, service will poll `'REQUEST'` AMQP queue for a **prio** job. It will validate the incoming record, send the validated record to the job's `operation.correlationId` AMQP queue and transition the job state to `'IMPORTER.IN_QUEUE'` in Mongo.

- if `'POLL_REQUEST'` is false, service will poll Mongo to find a **bulk** job in state `'VALIDATOR.PENDING_QUEUING'`. It will stream the jobs content from Mongo bucket and transform it to records, send the records to the job's `operation.correlationId` AMQP queue and transition the job state to `'IMPORTER.IN_QUEUE'` in Mongo.

### Environment variables
| Name           | Mandatory | Description                                                                                                        |
|----------------|-----------|--------------------------------------------------------------------------------------------------------------------|
| AMQP_URL       | Yes       | A serialized object of AMQP connection config                                                                      |
| SRU_URL_BIB    | Yes       | A serialized URL addres to SRU                                                                                     |
| MONGO_URI      | No        | A serialized URL address of Melinda-rest-api's import queue database. Defaults to `'mongodb://localhost:27017/db'` |
| OFFLINE_PERIOD | No        | Starting hour and length of offline period. e.g `'11,1'`                                                           |
| POLL_REQUEST   | No        | A numeric presentation of boolean option to start polling AMQP `'REQUEST'` queue when process is started e.g. `1`  |
| POLL_WAIT_TIME | No        | A number value presenting time in ms between polling. Defaults to `'1000'`                                         |
| LOG_LEVEL      | No        | Log information level                                                                                              |

### Mongo

Db: `'rest-api'`
Collections: `'prio'`, `'bulk'`

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
  }]
}
```

## License and copyright

Copyright (c) 2020-2021 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **GNU Affero General Public License Version 3** or any later version.
