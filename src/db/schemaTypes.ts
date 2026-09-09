export interface ColumnInfo {
    name: string;
    ordinal: number;
    typeName: string;
    typeDisplay: string;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    isPrimaryKey: boolean;
}

export interface TableInfo {
    /** Catalog / database this table lives in. */
    database: string;
    schema: string;
    name: string;
    /** schema.table (MSSQL / Postgres) or database.table (MySQL). */
    fullName: string;
    /** database.schema.table (MSSQL), schema.table (Postgres), or database.table (MySQL). */
    qualifiedName: string;
    isView: boolean;
    columns: ColumnInfo[];
    columnsByLower: Map<string, ColumnInfo>;
}
