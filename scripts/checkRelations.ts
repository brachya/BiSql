import assert from 'node:assert/strict';
import { SchemaCache } from '../src/db/schemaCache';
import { ColumnInfo, TableInfo } from '../src/db/schemaTypes';
import { buildTableRelations, isSelfRelation } from '../src/sql/tableRelations';

function column(name: string, typeName: string, pk = false, ordinal = 0, isIdentity = false): ColumnInfo {
    return {
        name,
        ordinal,
        typeName,
        typeDisplay: typeName,
        isNullable: !pk,
        isIdentity,
        isComputed: false,
        isPrimaryKey: pk
    };
}

function table(
    database: string,
    name: string,
    columns: ColumnInfo[],
    foreignKeys: TableInfo['foreignKeys'] = [],
    isView = false
): TableInfo {
    const columnsByLower = new Map<string, ColumnInfo>();
    for (const col of columns) {
        columnsByLower.set(col.name.toLowerCase(), col);
    }
    const qualifiedName = `${database}.${name}`;
    return {
        database,
        schema: database,
        name,
        fullName: `${database}.${name}`,
        qualifiedName,
        isView,
        columns,
        columnsByLower,
        foreignKeys
    };
}

const orders = table('shop', 'orders', [
    column('id', 'int', true),
    column('customer_id', 'int')
], [
    {
        name: 'fk_orders_customer',
        columns: ['customer_id', 'region_id'],
        refTable: 'shop.customers',
        refColumns: ['id', 'region_id']
    }
]);

const customers = table('shop', 'customers', [column('id', 'int', true), column('region_id', 'int')]);
const products = table('shop', 'products', [column('id', 'int', true)]);
const facilities = table('datalign_dev', 'facilities', [
    column('facility_id', 'int', true),
    column('name', 'varchar')
]);
const visits = table('datalign_dev', 'visits', [column('visit_id', 'int', true), column('facility_id', 'int')]);
const ambiguousA = table('datalign_dev', 'widgets', [column('widget_id', 'int', true)]);
const ambiguousB = table('datalign_dev', 'widget', [column('widget_id', 'int', true)]);
const typed = table('datalign_dev', 'typed_a', [column('facility_id', 'varchar')]);
const employees = table('hr', 'employees', [
    column('id', 'int', true),
    column('manager_id', 'int')
]);
const patients = table('datalign_dev', 'patients', [
    column('fac_id', 'int', false, 1),
    column('client_id', 'int', true, 2),
    column('client_id_number', 'varchar', false, 3)
]);
const varianceReport = table('datalign_dev', 'variance_report', [
    column('facility_id', 'int', false, 1),
    column('patient_name', 'varchar', false, 6),
    column('client_id', 'int', true, 7)
]);
const admissionMarReport = table('datalign_dev', 'admission_mar_report', [
    column('facility_id', 'int', false, 1),
    column('client_id', 'int', false, 2),
    column('admission_id', 'int', true, 3)
]);

const bundles = buildTableRelations([
    orders,
    customers,
    products,
    facilities,
    visits,
    ambiguousA,
    ambiguousB,
    typed,
    employees,
    patients,
    varianceReport,
    admissionMarReport
]);

const orderBundle = bundles.get('shop.orders')!;
assert.equal(orderBundle.outgoing.length, 1);
assert.equal(orderBundle.outgoing[0]!.guessed, false);
assert.equal(orderBundle.outgoing[0]!.fromColumns.join(','), 'customer_id,region_id');

const customerIncoming = bundles.get('shop.customers')!.incoming;
assert.equal(customerIncoming.length, 1);

const visitGuess = bundles.get('datalign_dev.visits')!.outgoing.find((rel) => rel.guessed);
assert.ok(visitGuess);
assert.equal(visitGuess.toTable, 'datalign_dev.facilities');
assert.equal(visitGuess.fromColumns[0], 'facility_id');
assert.equal(visitGuess.toColumns[0], 'facility_id');

assert.equal(bundles.get('datalign_dev.widgets')!.outgoing.length, 0);
assert.equal(bundles.get('datalign_dev.typed_a')!.outgoing.length, 0);

const admissionClientGuess = bundles
    .get('datalign_dev.admission_mar_report')!
    .outgoing.find((rel) => rel.fromColumns[0] === 'client_id');
assert.ok(admissionClientGuess);
assert.equal(admissionClientGuess.toTable, 'datalign_dev.patients');

const varianceClientGuess = bundles
    .get('datalign_dev.variance_report')!
    .outgoing.find((rel) => rel.fromColumns[0] === 'client_id');
assert.ok(varianceClientGuess);
assert.equal(varianceClientGuess.toTable, 'datalign_dev.patients');

const cache = new SchemaCache([orders, customers], Date.now(), false);
const snapshot = cache.serialize('test-key');
const restored = SchemaCache.deserialize(snapshot, 'mysql');
assert.equal(restored.tables[0]!.foreignKeys.length, 1);
assert.equal(restored.foreignKeysLoaded, true);

const legacy = SchemaCache.deserialize(
    {
        version: 3,
        connectionKey: 'test-key',
        fetchedAt: Date.now(),
        tables: [
            {
                db: 'shop',
                s: 'shop',
                n: 'orders',
                v: false,
                c: [
                    {
                        n: 'id',
                        o: 1,
                        t: 'int',
                        d: 'int',
                        nu: false,
                        id: false,
                        co: false,
                        pk: true
                    }
                ]
            }
        ]
    },
    'mysql'
);
assert.equal(legacy.foreignKeysLoaded, false);

assert.equal(isSelfRelation({
    fromTable: 'hr.employees',
    fromColumns: ['manager_id'],
    toTable: 'hr.employees',
    toColumns: ['id'],
    guessed: true,
    toCached: true
}), true);

console.log('checkRelations: ok');
