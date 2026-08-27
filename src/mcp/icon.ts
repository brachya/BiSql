import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface McpIcon {
    src: string;
    mimeType: 'image/png' | 'image/svg+xml';
    sizes?: string[];
}

export function loadExtensionPngIcon(extensionRoot: string): Buffer | undefined {
    return readOptionalFile(path.join(extensionRoot, 'media', 'icon.png'));
}

export function loadExtensionSvgIcon(extensionRoot: string): string | undefined {
    const bytes = readOptionalFile(path.join(extensionRoot, 'media', 'icon.svg'));
    return bytes ? bytes.toString('utf8') : undefined;
}

export function pngIconFromBytes(bytes: Buffer): McpIcon {
    return {
        src: `data:image/png;base64,${bytes.toString('base64')}`,
        mimeType: 'image/png'
    };
}

export function pngIconFromUrl(src: string): McpIcon {
    return {
        src,
        mimeType: 'image/png'
    };
}

export function svgIconFromText(svg: string): McpIcon {
    return {
        src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
        mimeType: 'image/svg+xml'
    };
}

function readOptionalFile(filePath: string): Buffer | undefined {
    try {
        return readFileSync(filePath);
    } catch {
        return undefined;
    }
}

export function isPublicIconPath(pathname: string): boolean {
    return pathname === '/icon.png' || pathname === '/favicon.ico';
}
