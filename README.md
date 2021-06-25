# Monaco TypeScript for ThingWorx Monaco Editor

This repo is a fork of https://github.com/microsoft/monaco-typescript/ for usage in https://github.com/ptc-iot-sharing/MonacoEditorTWX.

The following are the features different from the upstream branch:
* getting a list of referenced thingworx entities in a script
* capability to hide models from each other
* defining dynamic languages
## Issues

Please file issues concerning `monaco-typescript` in the [`monaco-editor` repository](https://github.com/ptc-iot-sharing/MonacoEditorTWX).

## Installing

This npm module is bundled and distributed in the [monaco-editor](https://www.npmjs.com/package/monaco-editor) npm module.

## Development

- `git clone https://github.com/placatus/monaco-typescript`
- `cd monaco-typescript`
- `npm install .`
- `npm run compile`
- `npm run watch`
- open `$/monaco-typescript/test/index.html` in your favorite browser.

## Updating TypeScript

- change typescript's version in `package.json`.
- execute `npm install .`
- execute `npm run import-typescript`
- adopt new APIs