'use strict';

/** One-off generator: SVG glyphs → WOFF for `contributes.icons`. */
module.exports = {
    inputDir: './media/icon-font',
    outputDir: './media',
    fontTypes: ['woff'],
    assetTypes: [],
    name: 'bisql-icons',
    prefix: 'bisql',
    normalize: true,
    fontHeight: 1000,
    descent: 150,
    codepoints: {
        'bisql-logo': 0xea01
    }
};
