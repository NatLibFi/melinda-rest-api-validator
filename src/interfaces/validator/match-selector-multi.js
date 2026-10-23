import {createLogger} from '@natlibfi/melinda-backend-commons';

const logger = createLogger();


/**
 * Build the default message text for multi-match notification.
 *
 * @param {object} params
 * @param {string[]} params.candidateIds - List of candidate record ids
 * @param {string} [params.catalogerId] - Cataloger/user id (optional)
 * @param {string} [params.catalogerName] - Cataloger/user name (optional)
 * @returns {string} Formatted message text
 */
export function buildMultiMatchMessage({candidateIds, catalogerId, catalogerName}) {
  const catalogerPart = catalogerId ? ', cataloger: ' + catalogerName + ' (' + catalogerId + ')' : '';
  const base = `multi-match from melinda-rest-api-validator, ${candidateIds.length} candidates found`;

  return base + catalogerPart;
}


/**
 * Multi-match handler: when matcher returns >1 candidate, send a message
 * to the duplicate-database for follow-up.
 *
 * Fire-and-forget: does NOT block the caller. On failure, logs a warning
 * and never throws.
 *
 * NOTE: this is a sync stub (just logging). When the real transport is
 * implemented, make this function async and callers must NOT await it
 * (call it without await, or with a .catch() to handle errors).
 *
 * @param {object} params
 * @param {MarcRecord} params.record - The incoming record (for context in message)
 * @param {string[]} params.candidateIds - List of candidate record ids
 * @param {string} params.messageText - Descriptive message text
 */
export function sendMultiMatchMessage({record, candidateIds, messageText}) {
  try {
    logger.info(
      `Multi-match detected: ${candidateIds.length} candidates for record ${record ? record.id : 'unknown'}`
    );
    logger.debug(`Multi-match message: ids=[${candidateIds.join(',')}], text=${messageText}`);

    // TODO: implement actual transport (HTTP/AMQP/etc.)
  } catch (err) {
    // Fire-and-forget: never let this break the main pipeline
    logger.warn(`sendMultiMatchMessage failed: ${err.message}`);
  }
}
