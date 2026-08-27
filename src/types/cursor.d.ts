declare module 'vscode' {
    export namespace cursor {
        export namespace mcp {
            export interface ServerIcon {
                dark: string;
                light: string;
            }

            export interface StdioServerConfig {
                name: string;
                title?: string;
                icon?: string | ServerIcon;
                server: {
                    command: string;
                    args: string[];
                    env: Record<string, string>;
                };
            }

            export interface RemoteServerConfig {
                name: string;
                title?: string;
                icon?: string | ServerIcon;
                server: {
                    url: string;
                    headers?: Record<string, string>;
                };
            }

            export type ExtMCPServerConfig = StdioServerConfig | RemoteServerConfig;

            export const registerServer: (config: ExtMCPServerConfig) => void;
            export const unregisterServer: (serverName: string) => void;
        }

        export namespace plugins {
            export const registerPath: (path: string) => void;
            export const unregisterPath: (path: string) => void;
        }
    }
}
