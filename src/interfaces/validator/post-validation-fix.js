import validateFactory from '@natlibfi/marc-record-validate';
import {
  FieldStructure as fieldStructure
} from '@natlibfi/marc-record-validators-melinda';
import {createLogger} from '@natlibfi/melinda-backend-commons';

// This should handle MELINDA <TEMP> cases in 856 $5 FI-Vapaa (ie. legalDeposit URNs created in DC/ONIX -> MARC21 -conversion for legalDeposits)

export default async () => {
  const logger = createLogger();

  logger.verbose('Run post validation fixes');
  const validate = validateFactory([await fieldStructure([{tag: /^003$/u, valuePattern: /^FI-MELINDA$/u}])]);

  return async unvalidRecord => {
    const {record, valid, report} = await validate(unvalidRecord, {fix: false, validateFixes: false}, {subfieldValues: false});

    return {
      record,
      failed: valid === false,
      messages: report
    };
  };
};
