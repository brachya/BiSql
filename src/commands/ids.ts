export const Commands = {
    openConnectionPanel: 'bisql.openConnectionPanel',
    openSchemaExplorer: 'bisql.openSchemaExplorer',
    setPassword: 'bisql.setPassword',
    clearPassword: 'bisql.clearPassword',
    refreshSchema: 'bisql.refreshSchema',
    testConnection: 'bisql.testConnection',
    validateCurrentFile: 'bisql.validateCurrentFile',
    validateProject: 'bisql.validateProject',
    enableInlineSuggestions: 'bisql.enableInlineSuggestions',
    clearSchemaCache: 'bisql.clearSchemaCache',
    runSelectedSql: 'bisql.runSelectedSql',
    formatSqlInFile: 'bisql.formatSqlInFile',
    formatSqlAt: 'bisql.formatSqlAt',
    explainSqlAt: 'bisql.explainSqlAt',
    validateSqlAt: 'bisql.validateSqlAt'
} as const;
