/* eslint-disable max-statements */
import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import {updateField001ToParamId} from '../utils';
import httpStatus from 'http-status';
import {promisify} from 'util';


export default function (amqpOperator) {
  const setTimeoutPromise = promisify(setTimeout);
  const logger = createLogger();

  return {streamToRecords};

  async function streamToRecords({correlationId, headers, contentType, stream}) {
    logger.log('info', 'Starting to transform stream to records');
    let recordNumber = 1; // eslint-disable-line functional/no-let
    const promises = [];

    // Purge queue before importing records in
    await amqpOperator.checkQueue(`${headers.operation}.${correlationId}`, 'messages', true);
    logger.log('verbose', 'Reading stream to records');

    return new Promise((resolve, reject) => {
      const reader = chooseAndInitReader(contentType);
      reader.on('error', err => {
        logError(err);
        reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid payload!'));
      }).on('data', data => {
        promises.push(transform(data, recordNumber)); // eslint-disable-line functional/immutable-data
        recordNumber += 1;

        log100thQueue(recordNumber, 'read');

        // This could input to Mongo also id:s of records to be handled: for updates Melinda-ID, for creates original 003+001 and temporary number
        async function transform(record, number) {
          // Operation CREATE -> f001 new value
          if (headers.operation === OPERATIONS.CREATE) {
            // Field 001 value -> 000000001, 000000002, 000000003....
            const updatedRecord = updateField001ToParamId(`${number}`, record);

            await amqpOperator.sendToQueue({queue: `${headers.operation}.${correlationId}`, correlationId, headers, data: updatedRecord.toObject()});
            return log100thQueue(number, 'queued');
          }

          await amqpOperator.sendToQueue({queue: `${headers.operation}.${correlationId}`, correlationId, headers, data: record.toObject()});
          return log100thQueue(number, 'queued');
        }
      })
        .on('end', async () => {
          logger.log('info', `Read ${promises.length} records from stream`);
          logger.log('info', 'Sending records to queue! This might take some time!');

          await setTimeoutPromise(500); // Makes sure that even slowest promise is in the array
          if (promises.length === 0) {
            return reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid payload!'));
          }

          await Promise.all(promises);
          logger.log('info', 'Request handling done!');
          // This could add to mongo the amount of records created totalRecordAmount
          resolve();
        });
    });

    function chooseAndInitReader(contentType) {
      logger.debug(`toMarcRecords/chooseAndInitReader: Choosing reader for contentType: ${contentType}`);
      if (contentType === 'application/alephseq') {
        logger.log('debug', 'AlephSeq stream!');
        return AlephSequential.reader(stream, {subfieldValues: false}, true);
      }

      if (contentType === 'application/json') {
        logger.log('debug', 'JSON stream!');
        return Json.reader(stream, {subfieldValues: false});
      }

      if (contentType === 'application/xml') {
        logger.log('debug', 'XML stream!');
        return MARCXML.reader(stream, {subfieldValues: false});
      }

      if (contentType === 'application/marc') {
        logger.log('debug', 'MARC stream!');
        return ISO2709.reader(stream, {subfieldValues: false});
      }

      throw new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Invalid content-type');
    }

    function log100thQueue(number, operation) {
      if (number % 100 === 0) {
        return logger.log('debug', `Record ${number} has been ${operation}`);
      }
      return logger.log('silly', `Record ${number} has been ${operation}`);
    }
  }
}
