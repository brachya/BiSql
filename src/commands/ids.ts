export const Commands = {
    openConnectionPanel: 'bisql.openConnectionPanel',
    setPassword: 'bisql.setPassword',
    clearPassword: 'bisql.clearPassword',
    refreshSchema: 'bisql.refreshSchema',
    testConnection: 'bisql.testConnection',
    validateCurrentFile: 'bisql.validateCurrentFile',
    enableInlineSuggestions: 'bisql.enableInlineSuggestions',
    clearSchemaCache: 'bisql.clearSchemaCache',
    runSelectedSql: 'bisql.runSelectedSql',
    formatSqlInFile: 'bisql.formatSqlInFile',
    setTableDatabasePreference: 'bisql.setTableDatabasePreference'
} as const;
