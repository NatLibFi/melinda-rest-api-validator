import {Utils} from '@natlibfi/melinda-commons';

const {toAlephId} = Utils;

export function updateField001ToParamId(id, record) {
	const fields = record.get(/^001$/);

	if (fields.length === 0) {
		// Return to break out of function
		return record.insertField({tag: '001', value: toAlephId(id)});
	}

	fields.map(field => {
		field.value = toAlephId(id);
		return field;
	});

	return record;
}
