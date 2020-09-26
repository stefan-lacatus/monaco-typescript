/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { WorkerManager } from './workerManager';
import type { TypeScriptWorker } from './tsWorker';
import { LanguageServiceDefaults } from './monaco.contribution';
import * as languageFeatures from './languageFeatures';
import { languages, Uri } from './fillers/monaco-editor-core';

let scriptWorkerMap: { [name: string]: (...uris: Uri[]) => Promise<TypeScriptWorker> } = {};

export function setupNamedLanguage(
	languageName: string,
	isTypescript: boolean,
	defaults: LanguageServiceDefaults
): void {
	scriptWorkerMap[languageName + 'Worker'] = setupMode(defaults, languageName);
}

export function getNamedLanguageWorker(
	languageName: string
): Promise<(...uris: Uri[]) => Promise<TypeScriptWorker>> {
	let workerName = languageName + 'Worker';
	return new Promise((resolve, reject) => {
		if (!scriptWorkerMap[workerName]) {
			return reject(languageName + ' not registered!');
		}

		resolve(scriptWorkerMap[workerName]);
	});
}

export function setupTypeScript(defaults: LanguageServiceDefaults): void {
	setupNamedLanguage('typescript', true, defaults);
}

export function setupJavaScript(defaults: LanguageServiceDefaults): void {
	setupNamedLanguage('javascript', false, defaults);
}

function setupMode(
	defaults: LanguageServiceDefaults,
	modeId: string
): (...uris: Uri[]) => Promise<TypeScriptWorker> {
	const client = new WorkerManager(modeId, defaults);
	const worker = (...uris: Uri[]): Promise<TypeScriptWorker> => {
		return client.getLanguageServiceWorker(...uris);
	};

	const libFiles = new languageFeatures.LibFiles(worker);

	languages.registerCompletionItemProvider(modeId, new languageFeatures.SuggestAdapter(worker));
	languages.registerSignatureHelpProvider(
		modeId,
		new languageFeatures.SignatureHelpAdapter(worker)
	);
	languages.registerHoverProvider(modeId, new languageFeatures.QuickInfoAdapter(worker));
	languages.registerDocumentHighlightProvider(
		modeId,
		new languageFeatures.OccurrencesAdapter(worker)
	);
	languages.registerDefinitionProvider(
		modeId,
		new languageFeatures.DefinitionAdapter(libFiles, worker)
	);
	languages.registerReferenceProvider(
		modeId,
		new languageFeatures.ReferenceAdapter(libFiles, worker)
	);
	languages.registerDocumentSymbolProvider(modeId, new languageFeatures.OutlineAdapter(worker));
	languages.registerDocumentRangeFormattingEditProvider(
		modeId,
		new languageFeatures.FormatAdapter(worker)
	);
	languages.registerOnTypeFormattingEditProvider(
		modeId,
		new languageFeatures.FormatOnTypeAdapter(worker)
	);
	languages.registerCodeActionProvider(modeId, new languageFeatures.CodeActionAdaptor(worker));
	languages.registerRenameProvider(modeId, new languageFeatures.RenameAdapter(worker));
	new languageFeatures.DiagnosticsAdapter(libFiles, defaults, modeId, worker);

	return worker;
}
