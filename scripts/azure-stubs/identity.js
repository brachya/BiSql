'use strict';

class AzureAuthNotBundled {
    constructor() {
        throw new Error(
            'Azure AD login is not included in BiSql. Use a SQL username and password.'
        );
    }
}

module.exports = {
    UsernamePasswordCredential: AzureAuthNotBundled,
    ManagedIdentityCredential: AzureAuthNotBundled,
    DefaultAzureCredential: AzureAuthNotBundled,
    ClientSecretCredential: AzureAuthNotBundled
};
