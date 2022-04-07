import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {updateField001ToParamId, getIdFromRecord, getRecordMetadata} from '../utils';
import httpStatus from 'http-status';
import {promisify} from 'util';
import {MarcRecordError} from '@natlibfi/marc-record';
import {OPERATIONS, logError, QUEUE_ITEM_STATE, createRecordResponseItem, addRecordResponseItem} from '@natlibfi/melinda-rest-api-commons';


export default function (amqpOperator, mongoOperator, splitterOptions) {
  const {failBulkOnError, keepSplitterReport} = splitterOptions;
  const setTimeoutPromise = promisify(setTimeout);
  const logger = createLogger();

  return {streamToRecords};

  // failBulkOnError env option is used as failOnError if failOnError is not given as a parameter
  async function streamToRecords({correlationId, headers, contentType, stream, failOnError = failBulkOnError, validateRecords = false, noop = false}) {
    logger.verbose(`Starting to transform stream to records`);
    logger.debug(`ValidateRecords: ${validateRecords}, failOnError: ${failOnError}, noop: ${noop}`);
    logger.debug(`Headers: ${JSON.stringify(headers)}`);
    logger.debug(`ContentType: ${JSON.stringify(contentType)}`);
    // recordNumber is counter for data-events from the reader
    let recordNumber = 0; // eslint-disable-line functional/no-let
    // sequenceNumber is counter for data and error events from the reader
    let sequenceNumber = 0; // eslint-disable-line functional/no-let
    // promises contains record promises from the reader
    const promises = [];
    let readerErrored = false; // eslint-disable-line functional/no-let
    const readerErrors = [];


    // Purge queue before importing records in
    await amqpOperator.checkQueue({queue: `${headers.operation}.${correlationId}`, style: 'messages', purge: true});
    logger.verbose('Reading stream to records');
    logger.debug(`Headers: ${JSON.stringify(headers)}`);

    return new Promise((resolve, reject) => {
      const reader = chooseAndInitReader(contentType);
      reader
        .on('error', err => {
          readerErrored = true;
          sequenceNumber += 1;
          logger.debug(`Reader seq: ${sequenceNumber} error`);
          logError(err);
          const cleanErrorMessage = err.message.replace(/(?<lineBreaks>\r\n|\n|\r)/gmu, ' ');

          readerErrors.push({sequenceNumber, error: cleanErrorMessage}); // eslint-disable-line functional/immutable-data
          // eslint-disable-next-line functional/no-conditional-statement
          if (err instanceof MarcRecordError) {
            logger.debug(`Error is MarcRecordError`);
          }

          const recordResponseItem = createRecordResponseItem({responseStatus: httpStatus.UNPROCESSABLE_ENTITY, responsePayload: cleanErrorMessage, recordMetadata: getRecordMetadata(undefined, sequenceNumber), id: undefined});
          addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

          // eslint-disable-next-line functional/no-conditional-statement
          if (failOnError) {
            reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, `Invalid payload! (${sequenceNumber}) ${cleanErrorMessage}`));
          }
        })
        .on('data', data => {
          sequenceNumber += 1;
          logger.silly(`Reader sequence: ${sequenceNumber} data`);

          if (readerErrored && failOnError) {
            logger.silly(`Reader already errored, no need to handle data.`);
            return;
          }
          recordNumber += 1;
          logger.silly(`Record number ${recordNumber}`);

          // SequenceNumber instead of recordNumber here - failed 'records' count as records
          promises.push(transform(data, sequenceNumber)); // eslint-disable-line functional/immutable-data

          log100thQueue(recordNumber, 'read');

          async function transform(record, number) {

            logger.debug(`Adding record information to the headers`);
            const recordMetadata = getRecordMetadata(record, number);
            // This should error if there's no id available for UPDATEs
            const id = headers.operation === OPERATIONS.CREATE ? number : getIdFromRecord(record);

            const newHeaders = {
              ...headers,
              recordMetadata,
              id
            };

            // Operation CREATE -> f001 new value -> 000000001, 000000002, 000000003....
            const recordToQueue = headers.operation === OPERATIONS.CREATE ? updateField001ToParamId(`${number}`, record) : record;
            const queue = validateRecords ? `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}` : `${headers.operation}.${correlationId}`;

            logger.debug(`validateRecords: ${validateRecords}`);
            logger.debug(`queue: ${queue}, newHeaders ${JSON.stringify(newHeaders)}`);

            // Noops with no validation do not need to go to the queue
            if (validateRecords || !noop) {
              await amqpOperator.sendToQueue({queue, correlationId, headers: newHeaders, data: recordToQueue.toObject()});
              return log100thQueue(number, 'queued');
            }

            const status = headers.operation === OPERATIONS.CREATE ? 'CREATED' : 'UPDATED';
            const melindaId = headers.operation === OPERATIONS.CREATE ? '000000000' : id;
            const recordResponseItem = createRecordResponseItem({responseStatus: status, responsePayload: 'Record read from stream. Noop.', recordMetadata, id: melindaId});
            addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

            return log100thQueue(number, 'noop response created');
          }
        })
        .on('end', async () => {
          await setTimeoutPromise(500); // Makes sure that even slowest promise is in the array
          const queue = validateRecords ? `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}` : `${headers.operation}.${correlationId}`;

          logger.verbose(`Read ${promises.length} records from stream (${recordNumber} recs, ${readerErrors.length} errors from ${sequenceNumber} reader events.)`);
          logger.info(`Sending ${promises.length} records to queue ${queue}! This might take some time!`);
          // Add blobSize, just for completeness sake
          mongoOperator.setBlobSize({correlationId, blobSize: sequenceNumber});

          // eslint-disable-next-line functional/no-conditional-statement
          if (promises.length === 0) {
            logger.debug(`Got no record promises from reader stream`);
            reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid payload!'));
          }

          await Promise.all(promises);
          logger.info(`Request handling done for ${correlationId}`);

          createSplitterReport();

          if (readerErrored && failOnError) {
            logger.debug(`Reader errored, failOnError active, removing the queue.`);
            amqpOperator.removeQueue(`${headers.operation}.${correlationId}`);
            return resolve();
          }
          return resolve();

        });

      // Note: splitterReport is created only if the reader emit an end event
      function createSplitterReport() {
        logger.debug(`Creating splitterReport to queueItem if needed`);
        if ((keepSplitterReport === 'ALL') || (keepSplitterReport === 'ERROR' && readerErrored)) { // eslint-disable-line no-extra-parens
          logger.debug(`Got ${readerErrors.length} errors. Pushing report to mongo`);
          const splitterReport = {recordNumber, sequenceNumber, readerErrors};
          mongoOperator.pushMessages({correlationId, messages: [splitterReport], messageField: 'splitterReport'});
          return;
        }
        return;
      }

    });

    function chooseAndInitReader(contentType) {
      logger.debug(`toMarcRecords/chooseAndInitReader: Choosing reader for contentType: ${contentType}`);
      if (contentType === 'application/alephseq') {
        logger.debug('AlephSeq stream!');
        // 3rd param true: genF001fromSysNo
        return AlephSequential.reader(stream, {subfieldValues: false}, true);
      }

      if (contentType === 'application/json') {
        logger.debug('JSON stream!');
        return Json.reader(stream, {subfieldValues: false});
      }

      if (contentType === 'application/xml') {
        logger.debug('XML stream!');
        return MARCXML.reader(stream, {subfieldValues: false});
      }

      if (contentType === 'application/marc') {
        logger.debug('MARC stream!');
        return ISO2709.reader(stream, {subfieldValues: false});
      }

      throw new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Invalid content-type');
    }

    function log100thQueue(number, operation) {
      if (number % 100 === 0) {
        return logger.debug(`Record ${number} has been ${operation}`);
      }
      return logger.silly(`Record ${number} has been ${operation}`);
    }
  }
}
