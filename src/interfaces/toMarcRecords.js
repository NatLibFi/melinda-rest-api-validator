import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError, toAlephId} from '@natlibfi/melinda-commons';
import {updateField001ToParamId, getIdFromRecord, getRecordMetadata, isValidAlephId} from '../utils';
import httpStatus from 'http-status';
import {promisify, inspect} from 'util';
import {MarcRecordError} from '@natlibfi/marc-record';
import {OPERATIONS, logError, QUEUE_ITEM_STATE, createRecordResponseItem, addRecordResponseItem, mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';

export default async function ({amqpOperator, mongoOperator, splitterOptions, mongoUri}) {
  const {failBulkOnError, keepSplitterReport} = splitterOptions;
  const setTimeoutPromise = promisify(setTimeout);
  const logger = createLogger();
  const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {streamToRecords};

  // failBulkOnError env option is used as failOnError if failOnError is not given as a parameter
  // failOnError fails bulk for a single recordTransformation error
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
    let transformerErrored = false; // eslint-disable-line functional/no-let
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

          // Reader returns "Record is invalid" -error, if the input is a valid array, but an element is not a valid MarcRecord
          const recordErrorRegExp = /^Record is invalid/u;
          const recordError = err instanceof MarcRecordError || recordErrorRegExp.test(err.message);

          logger.debug(`Error is a recordError: ${recordError}`);

          const recordResponseItem = createRecordResponseItem({responseStatus: httpStatus.UNPROCESSABLE_ENTITY, responsePayload: cleanErrorMessage, recordMetadata: getRecordMetadata({record: undefined, number: sequenceNumber}), id: undefined});
          addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

          // eslint-disable-next-line functional/no-conditional-statement
          if (failOnError || !recordError) {
            createSplitterReportAndLogs();
            reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, `Invalid payload! (${sequenceNumber}) ${cleanErrorMessage}`));
          }
        })
        .on('data', data => {
          sequenceNumber += 1;
          logger.silly(`Reader sequence: ${sequenceNumber} data`);

          if ((readerErrored || transformerErrored) && failOnError) {
            logger.silly(`Reader already errored, no need to handle data.`);
            return;
          }
          recordNumber += 1;
          logger.silly(`Record number ${recordNumber}`);

          // SequenceNumber instead of recordNumber here - failed 'records' count as records
          promises.push(transform(data, sequenceNumber)); // eslint-disable-line functional/immutable-data

          log100thQueue(recordNumber, 'read');

          // eslint-disable-next-line max-statements
          async function transform(record, number) {

            logger.debug(`Adding record information to the headers`);
            const getAllSourceIds = headers.operation === OPERATIONS.CREATE;

            logger.debug(`Getting recordMetadata`);
            const recordMetadata = getRecordMetadata({record, number, getAllSourceIds});

            logger.debug(`Getting id - use ${number} for CREATE, get ID from record for UPDATE`);
            const id = headers.operation === OPERATIONS.CREATE ? toAlephId(number) : getIdFromRecord(record);

            logger.debug(`ID: ${id} for ${headers.operation}`);
            if (!id || !isValidAlephId(id)) {
              logger.debug(`Record ${number} has no valid id for ${headers.operation}. Available id: $<${id}>.`);
              const responsePayload = {message: `Invalid payload! Record ${number} has no valid id for ${headers.operation}. Available id: <${id}>.`};
              const recordResponseItem = createRecordResponseItem({responseStatus: httpStatus.UNPROCESSABLE_ENTITY, responsePayload, recordMetadata, id: undefined});
              addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

              readerErrors.push({sequenceNumber, error: responsePayload}); // eslint-disable-line functional/immutable-data
              transformerErrored = true;
              // eslint-disable-next-line functional/no-conditional-statement
              if (failOnError) {
                reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, responsePayload));
              }
              return;
            }

            const newHeaders = {
              ...headers,
              recordMetadata,
              id
            };

            // Operation CREATE -> f001 new value -> 000000001, 000000002, 000000003....
            logger.debug(`set ${number} as id to CREATE`);
            const recordToQueue = headers.operation === OPERATIONS.CREATE ? updateField001ToParamId(`${number}`, record) : record;
            //const recordToQueue = record;
            const queue = validateRecords ? `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}` : `${headers.operation}.${correlationId}`;

            logger.debug(`validateRecords: ${validateRecords}`);
            logger.debug(`queue: ${queue}, newHeaders ${JSON.stringify(newHeaders)}`);
            logger.debug(`recordtoQueue: ${recordToQueue}`);

            // Noops with no validation do not need to go to the queue
            if (validateRecords || !noop) {
              await amqpOperator.sendToQueue({queue, correlationId, headers: newHeaders, data: recordToQueue.toObject()});
              return log100thQueue(number, 'queued');
            }

            const status = headers.operation === OPERATIONS.CREATE ? 'CREATED' : 'UPDATED';
            const databaseId = headers.operation === OPERATIONS.CREATE ? '000000000' : id;
            const recordResponseItem = createRecordResponseItem({responseStatus: status, responsePayload: 'Record read from stream. Noop.', recordMetadata, id: databaseId});
            addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

            return log100thQueue(number, 'noop response created');
          }
        })
        .on('end', async () => {
          logger.debug(`We got end from the reader`);
          await setTimeoutPromise(500); // Makes sure that even slowest promise is in the array
          const queue = validateRecords ? `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}` : `${headers.operation}.${correlationId}`;

          logger.verbose(`Read ${promises.length} records from stream (${recordNumber} recs, ${readerErrors.length} errors from ${sequenceNumber} reader events.)`);
          logger.info(`Sending ${promises.length} records to queue ${queue}! This might take some time!`);
          // Add blobSize, just for completeness sake
          mongoOperator.setBlobSize({correlationId, blobSize: sequenceNumber});

          // eslint-disable-next-line functional/no-conditional-statement
          if (promises.length === 0) {
            logger.debug(`Got no record promises from reader stream`);
            createSplitterReportAndLogs();
            reject(new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid payload!'));
          }

          await Promise.all(promises);
          logger.info(`Request handling done for ${correlationId}`);

          createSplitterReportAndLogs();

          if ((readerErrored || transformerErrored) && failOnError) {
            logger.debug(`Reader or transformer errored, failOnError active, removing the queue.`);
            amqpOperator.removeQueue(`${headers.operation}.${correlationId}`);
            return resolve();
          }
          return resolve();

        });

      function createSplitterReportAndLogs() {

        const splitterReport = {recordNumber, sequenceNumber, readerErrors};

        const splitterLogItem = {
          logItemType: 'SPLITTER_LOG',
          correlationId,
          ...splitterReport
        };

        logger.debug(`${inspect(splitterLogItem, {depth: 6})}`);
        const result = mongoLogOperator.addLogItem(splitterLogItem);
        logger.debug(result);

        logger.debug(`Creating splitterReport to queueItem if needed`);
        if ((keepSplitterReport === 'ALL') || (keepSplitterReport === 'ERROR' && (readerErrored || transformerErrored))) { // eslint-disable-line no-extra-parens
          logger.debug(`Got ${readerErrors.length} errors. Pushing report to mongo`);
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
