import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import {updateField001ToParamId} from '../utils';
import httpStatus from 'http-status';

export default function (amqpOperator) {
  const {createLogger} = Utils;
  const logger = createLogger();

  return {streamToRecords};

  async function streamToRecords({correlationId, headers, contentType, stream}) {
    logger.log('info', 'Starting to transform stream to records');
    let recordNumber = 0; // eslint-disable-line functional/no-let
    const promises = [];

    // Purge queue before importing records in
    await amqpOperator.checkQueue(correlationId, 'messages', true);
    logger.log('info', 'Reading stream to records');

    return new Promise((resolve, reject) => {
      const reader = chooseAndInitReader(contentType);
      reader.on('error', err => {
        logError(err);
        reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid payload!'));
      }).on('data', data => {
        promises.push(transform(data, recordNumber)); // eslint-disable-line functional/immutable-data
        recordNumber += 1;

        log100thQueue(recordNumber, 'read');

        async function transform(record, number) {
          // Operation CREATE -> f001 new value
          if (headers.operation === OPERATIONS.CREATE) {
            // Field 001 value -> 000000000, 000000001, 000000002....
            const updatedRecord = updateField001ToParamId(`${number}`, record);

            await amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: updatedRecord.toObject()});
            return log100thQueue(number, 'queued');
          }

          await amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: record.toObject()});
          return log100thQueue(number, 'queued');
        }
      })
        .on('end', async () => {
          logger.log('info', `Read ${promises.length} records from stream`);
          logger.log('info', 'This might take some time!');
          await Promise.all(promises);
          logger.log('info', 'Request handling done!');
          resolve();
        });
    });

    function chooseAndInitReader(contentType) {
      if (contentType === 'application/alephseq') {
        logger.log('info', 'AlephSeq stream!');
        return new AlephSequential.Reader(stream);
      }

      if (contentType === 'application/json') {
        logger.log('info', 'JSON stream!');
        return new Json.Reader(stream);
      }

      if (contentType === 'application/xml') {
        logger.log('info', 'XML stream!');
        return new MARCXML.Reader(stream);
      }

      if (contentType === 'application/marc') {
        logger.log('info', 'MARC stream!');
        return new ISO2709.Reader(stream);
      }

      throw new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Invalid content-type');
    }

    function log100thQueue(number, operation) {
      if (number % 100 === 0) {
        return logger.log('debug', `Record ${number} has been ${operation}`);
      }
    }
  }
}
