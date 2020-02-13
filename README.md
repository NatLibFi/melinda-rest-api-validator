# Service for validating and queuing import records from melinda-rest-api

## Usage
While service is in operation, if `'POLL_REQUEST'` is true, service will poll AMQP `'REQUEST'` queue and validate any incoming items.
If `'POLL_REQUEST'` is false, service will poll mongo db if there is any job in state `'PENDING_QUEUING'`, if one is found will service stream it from bucket and QUEUE it to AMQP.

### Environment variables
| Name           | Mandatory | Description                                                                                                        |
|----------------|-----------|--------------------------------------------------------------------------------------------------------------------|
| AMQP_URL       | Yes       | A serialized object of AMQP connection config                                                                      |
| SRU_URL_BIB    | Yes       | A serialized URL addres to SRU                                                                                     |
| MONGO_URI      | No        | A serialized URL address of Melinda-rest-api's import queue database. Defaults to `'mongodb://localhost:27017/db'` |
| OFFLINE_PERIOD | No        | Starting hour and length of offline period. e.g `'11,1'`                                                           |
| POLL_REQUEST   | No        | A numeric presentation of boolean option to start polling AMQP `'REQUEST'` queue when process is started e.g. `1`  |
| POLL_WAIT_TIME | No        | A number value presenting time in ms between polling. Defaults to `'1000'`                                         |

### Mongo
Db: `'rest-api'`
Table: `'queue-items'`
Bucket name: `'queueItems'`
Queue-item schema:
```json
{
	"correlationId":"FOO",
	"cataloger":"xxx0000",
	"operation":"UPDATE",
	"contentType":"application/json",
	"recordLoadParams": {
        "library": "XXX00",
        "inputFile": "filename.seq",
        "method": "NEW",
        "fixRoutine": "INSB",
        "space": "",
        "indexing": "FULL",
        "updateAction": "APP",
        "mode": "M",
        "charConversion": "",
        "mergeRoutine": "",
        "cataloger": "XXX0000",
        "catalogerLevel": "",
        "indexingPriority": "2099"
      },
	"queueItemState":"PENDING_QUEUING",
	"creationTime":"2020-01-01T00:00:00.000Z",
	"modificationTime":"2020-01-01T00:00:01.000Z"
}
```

## License and copyright

Copyright (c) 2020-2020 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **GNU Affero General Public License Version 3** or any later version.
