/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as ts from './lib/typescriptServices';
import { libFileMap } from './lib/lib';
import {
	Diagnostic,
	DiagnosticRelatedInformation,
	IExtraLibs,
	TypeScriptWorker as ITypeScriptWorker
} from './monaco.contribution';
import { Uri, worker } from './fillers/monaco-editor-core';

/**
 * Loading a default lib as a source file will mess up TS completely.
 * So our strategy is to hide such a text model from TS.
 * See https://github.com/microsoft/monaco-editor/issues/2182
 */
function fileNameIsLib(resource: Uri | string): boolean {
	if (typeof resource === 'string') {
		if (/^file:\/\/\//.test(resource)) {
			return !!libFileMap[resource.substr(8)];
		}
		return false;
	}
	if (resource.path.indexOf('/lib.') === 0) {
		return !!libFileMap[resource.path.slice(1)];
	}
	return false;
}

interface CodeOutlineToken {
	name: string;
	kind: CodeOutlineTokenKind;
	ordinal: number;
	line: number;
	indentAmount: number;
}

export enum CodeOutlineTokenKind {
	Class = 'Class',
	ObjectLiteral = 'ObjectLiteral',
	Method = 'Method',
	Constructor = 'Constructor',
	Function = 'Function',
	Get = 'Get',
	Set = 'Set'
}

export class TypeScriptWorker implements ts.LanguageServiceHost, ITypeScriptWorker {
	// --- model sync -----------------------

	private _ctx: worker.IWorkerContext;
	private _extraLibs: IExtraLibs = Object.create(null);
	private _languageService = ts.createLanguageService(this);
	private _compilerOptions: ts.CompilerOptions;

	constructor(ctx: worker.IWorkerContext, createData: ICreateData) {
		this._ctx = ctx;
		this._compilerOptions = createData.compilerOptions;
		this._extraLibs = createData.extraLibs;
	}

	// --- language service host ---------------

	getCompilationSettings(): ts.CompilerOptions {
		return this._compilerOptions;
	}

	getScriptFileNames(): string[] {
		const allModels = this._ctx.getMirrorModels().map((model) => model.uri);
		const models = allModels.filter((uri) => !fileNameIsLib(uri)).map((uri) => uri.toString());
		return models.concat(Object.keys(this._extraLibs));
	}

	private _getModel(fileName: string): worker.IMirrorModel | null {
		let models = this._ctx.getMirrorModels();
		for (let i = 0; i < models.length; i++) {
			if (models[i].uri.toString() === fileName) {
				return models[i];
			}
		}
		return null;
	}

	getScriptVersion(fileName: string): string {
		let model = this._getModel(fileName);
		if (model) {
			return model.version.toString();
		} else if (this.isDefaultLibFileName(fileName)) {
			// default lib is static
			return '1';
		} else if (fileName in this._extraLibs) {
			return String(this._extraLibs[fileName].version);
		}
		return '';
	}

	async getScriptText(fileName: string): Promise<string | undefined> {
		return this._getScriptText(fileName);
	}

	_getScriptText(fileName: string): string | undefined {
		let text: string;
		let model = this._getModel(fileName);
		const libizedFileName = 'lib.' + fileName + '.d.ts';
		if (model) {
			// a true editor model
			text = model.getValue();
		} else if (fileName in libFileMap) {
			text = libFileMap[fileName];
		} else if (libizedFileName in libFileMap) {
			text = libFileMap[libizedFileName];
		} else if (fileName in this._extraLibs) {
			// extra lib
			text = this._extraLibs[fileName].content;
		} else {
			return;
		}

		return text;
	}

	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		const text = this._getScriptText(fileName);
		if (text === undefined) {
			return;
		}

		return <ts.IScriptSnapshot>{
			getText: (start, end) => text.substring(start, end),
			getLength: () => text.length,
			getChangeRange: () => undefined
		};
	}

	getScriptKind?(fileName: string): ts.ScriptKind {
		const suffix = fileName.substr(fileName.lastIndexOf('.') + 1);
		switch (suffix) {
			case 'ts':
				return ts.ScriptKind.TS;
			case 'tsx':
				return ts.ScriptKind.TSX;
			case 'js':
				return ts.ScriptKind.JS;
			case 'jsx':
				return ts.ScriptKind.JSX;
			default:
				return this.getCompilationSettings().allowJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
		}
	}

	getCurrentDirectory(): string {
		return '';
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		switch (options.target) {
			case 99 /* ESNext */:
				const esnext = 'lib.esnext.full.d.ts';
				if (esnext in libFileMap || esnext in this._extraLibs) return esnext;
			case 7 /* ES2020 */:
			case 6 /* ES2019 */:
			case 5 /* ES2018 */:
			case 4 /* ES2017 */:
			case 3 /* ES2016 */:
			case 2 /* ES2015 */:
			default:
				// Support a dynamic lookup for the ES20XX version based on the target
				// which is safe unless TC39 changes their numbering system
				const eslib = `lib.es${2013 + (options.target || 99)}.full.d.ts`;
				// Note: This also looks in _extraLibs, If you want
				// to add support for additional target options, you will need to
				// add the extra dts files to _extraLibs via the API.
				if (eslib in libFileMap || eslib in this._extraLibs) {
					return eslib;
				}

				return 'lib.es6.d.ts'; // We don't use lib.es2015.full.d.ts due to breaking change.
			case 1:
			case 0:
				return 'lib.d.ts';
		}
	}

	isDefaultLibFileName(fileName: string): boolean {
		return fileName === this.getDefaultLibFileName(this._compilerOptions);
	}

	async getLibFiles(): Promise<Record<string, string>> {
		return libFileMap;
	}

	// --- language features

	private static clearFiles(tsDiagnostics: ts.Diagnostic[]): Diagnostic[] {
		// Clear the `file` field, which cannot be JSON'yfied because it
		// contains cyclic data structures, except for the `fileName`
		// property.
		// Do a deep clone so we don't mutate the ts.Diagnostic object (see https://github.com/microsoft/monaco-editor/issues/2392)
		const diagnostics: Diagnostic[] = [];
		for (const tsDiagnostic of tsDiagnostics) {
			const diagnostic: Diagnostic = { ...tsDiagnostic };
			diagnostic.file = diagnostic.file ? { fileName: diagnostic.file.fileName } : undefined;
			if (tsDiagnostic.relatedInformation) {
				diagnostic.relatedInformation = [];
				for (const tsRelatedDiagnostic of tsDiagnostic.relatedInformation) {
					const relatedDiagnostic: DiagnosticRelatedInformation = { ...tsRelatedDiagnostic };
					relatedDiagnostic.file = relatedDiagnostic.file ? { fileName: relatedDiagnostic.file.fileName } : undefined
					diagnostic.relatedInformation.push(relatedDiagnostic);
				}
			}
			diagnostics.push(diagnostic);
		}
		return diagnostics;
	}

	async getSyntacticDiagnostics(fileName: string): Promise<Diagnostic[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		const diagnostics = this._languageService.getSyntacticDiagnostics(fileName);
		return TypeScriptWorker.clearFiles(diagnostics);
	}

	async getSemanticDiagnostics(fileName: string): Promise<Diagnostic[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		const diagnostics = this._languageService.getSemanticDiagnostics(fileName);
		return TypeScriptWorker.clearFiles(diagnostics);
	}

	async getSuggestionDiagnostics(fileName: string): Promise<Diagnostic[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		const diagnostics = this._languageService.getSuggestionDiagnostics(fileName);
		return TypeScriptWorker.clearFiles(diagnostics);
	}

	async getCompilerOptionsDiagnostics(fileName: string): Promise<Diagnostic[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		const diagnostics = this._languageService.getCompilerOptionsDiagnostics();
		return TypeScriptWorker.clearFiles(diagnostics);
	}

	async getCompletionsAtPosition(
		fileName: string,
		position: number
	): Promise<ts.CompletionInfo | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getCompletionsAtPosition(fileName, position, undefined);
	}

	async getCompletionEntryDetails(
		fileName: string,
		position: number,
		entry: string
	): Promise<ts.CompletionEntryDetails | undefined> {
		return this._languageService.getCompletionEntryDetails(
			fileName,
			position,
			entry,
			undefined,
			undefined,
			undefined,
			undefined
		);
	}

	async getSignatureHelpItems(
		fileName: string,
		position: number,
		options: ts.SignatureHelpItemsOptions | undefined
	): Promise<ts.SignatureHelpItems | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getSignatureHelpItems(fileName, position, options);
	}

	async getQuickInfoAtPosition(
		fileName: string,
		position: number
	): Promise<ts.QuickInfo | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getQuickInfoAtPosition(fileName, position);
	}

	async getOccurrencesAtPosition(
		fileName: string,
		position: number
	): Promise<ReadonlyArray<ts.ReferenceEntry> | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getOccurrencesAtPosition(fileName, position);
	}

	async getDefinitionAtPosition(
		fileName: string,
		position: number
	): Promise<ReadonlyArray<ts.DefinitionInfo> | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getDefinitionAtPosition(fileName, position);
	}

	async getReferencesAtPosition(
		fileName: string,
		position: number
	): Promise<ts.ReferenceEntry[] | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.getReferencesAtPosition(fileName, position);
	}

	async getNavigationBarItems(fileName: string): Promise<ts.NavigationBarItem[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		return this._languageService.getNavigationBarItems(fileName);
	}

	async getFormattingEditsForDocument(
		fileName: string,
		options: ts.FormatCodeOptions
	): Promise<ts.TextChange[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		return this._languageService.getFormattingEditsForDocument(fileName, options);
	}

	async getFormattingEditsForRange(
		fileName: string,
		start: number,
		end: number,
		options: ts.FormatCodeOptions
	): Promise<ts.TextChange[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		return this._languageService.getFormattingEditsForRange(fileName, start, end, options);
	}

	async getFormattingEditsAfterKeystroke(
		fileName: string,
		postion: number,
		ch: string,
		options: ts.FormatCodeOptions
	): Promise<ts.TextChange[]> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		return this._languageService.getFormattingEditsAfterKeystroke(fileName, postion, ch, options);
	}

	async findRenameLocations(
		fileName: string,
		position: number,
		findInStrings: boolean,
		findInComments: boolean,
		providePrefixAndSuffixTextForRename: boolean
	): Promise<readonly ts.RenameLocation[] | undefined> {
		if (fileNameIsLib(fileName)) {
			return undefined;
		}
		return this._languageService.findRenameLocations(
			fileName,
			position,
			findInStrings,
			findInComments,
			providePrefixAndSuffixTextForRename
		);
	}

	async getRenameInfo(
		fileName: string,
		position: number,
		options: ts.RenameInfoOptions
	): Promise<ts.RenameInfo> {
		if (fileNameIsLib(fileName)) {
			return { canRename: false, localizedErrorMessage: 'Cannot rename in lib file' };
		}
		return this._languageService.getRenameInfo(fileName, position, options);
	}

	async getEmitOutput(fileName: string): Promise<ts.EmitOutput> {
		if (fileNameIsLib(fileName)) {
			return { outputFiles: [], emitSkipped: true };
		}
		return this._languageService.getEmitOutput(fileName);
	}

	async getCodeFixesAtPosition(
		fileName: string,
		start: number,
		end: number,
		errorCodes: number[],
		formatOptions: ts.FormatCodeOptions
	): Promise<ReadonlyArray<ts.CodeFixAction>> {
		if (fileNameIsLib(fileName)) {
			return [];
		}
		const preferences = {};
		try {
			return this._languageService.getCodeFixesAtPosition(
				fileName,
				start,
				end,
				errorCodes,
				formatOptions,
				preferences
			);
		} catch {
			return [];
		}
	}

	async updateExtraLibs(extraLibs: IExtraLibs): Promise<void> {
		this._extraLibs = extraLibs;
	}

	getPropertiesOrAttributesOf(
		fileName: string,
		parentObjects: string[]
	): { [name: string]: { [name: string]: boolean } } {
		let referencedEntities: { [name: string]: { [name: string]: boolean } } = {};
		parentObjects.forEach(function (key) {
			referencedEntities[key] = {};
		});
		let program = this._languageService.getProgram();
		if (program) {
			let currentFile = program.getSourceFile(fileName);
			if (currentFile) {
				let typeChecker = program.getTypeChecker();

				ts.forEachChild(currentFile, function visitNodes(node: ts.Node) {
					if (
						ts.isPropertyAccessExpression(node) &&
						referencedEntities[node.expression.getText()]
					) {
						// Matches Things.test
						if (!(node.name.text in referencedEntities[node.expression.getText()])) {
							referencedEntities[node.expression.getText()][node.name.text] = true;
						}
					} else if (
						ts.isElementAccessExpression(node) &&
						referencedEntities[node.expression.getText()] &&
						node.argumentExpression
					) {
						if (node.argumentExpression.kind == ts.SyntaxKind.Identifier) {
							if (
								node.expression.getText() == 'Users' &&
								node.argumentExpression.getText() == 'principal'
							) {
								// a special case for Users[principal] => replace principal with "Administrator",
								// since all users have the same properties and functions
								referencedEntities['Users']['System'] = true;
							}
						}
						if (node.argumentExpression.kind == ts.SyntaxKind.PropertyAccessExpression) {
							// matches Things[me.property]
							let type = typeChecker.getTypeAtLocation(node.argumentExpression);
							if ('value' in type) {
								referencedEntities[node.expression.getText()][(type as any)['value']] = true;
							}
						} else if (ts.isStringLiteral(node.argumentExpression)) {
							// matches Things["test"]
							referencedEntities[node.expression.getText()][
								node.argumentExpression.getText().slice(1, -1)
							] = true;
						}
					}
					ts.forEachChild(node, visitNodes);
				});
			}
		}
		return referencedEntities;
	}

	getOutline(fileName: string, parentObjects: string[]): CodeOutlineToken[] {
		let tokens: CodeOutlineToken[] = [];
		let program = this._languageService.getProgram();
		if (program) {
			let currentFile = program.getSourceFile(fileName);
			if (currentFile) {
				let ordinal = 0;
				let indentation = 0;

				const getEscapedTextOfIdentifierOrLiteral = function (node?: {
					kind: ts.SyntaxKind;
					escapedText?: ts.__String;
					text?: string;
				}): string | undefined {
					if (node) {
						return node.kind === ts.SyntaxKind.Identifier
							? (node.escapedText as string)
							: node.text;
					}
				};

				const extractLiteral = (liternalNode: ts.ObjectLiteralExpression) => {
					let didExtractLiteral = false;

					// Object literals should only be extracted if they have at least a method or any getter/setter
					let methodCount = 0;
					liternalNode.properties.forEach((property) => {
						switch (property.kind) {
							case ts.SyntaxKind.MethodDeclaration:
								methodCount++;
								break;
							case ts.SyntaxKind.GetAccessor:
							case ts.SyntaxKind.SetAccessor:
								didExtractLiteral = true;
								break;
							case ts.SyntaxKind.PropertyAssignment:
								if (
									property.initializer &&
									(property.initializer.kind == ts.SyntaxKind.FunctionDeclaration ||
										property.initializer.kind == ts.SyntaxKind.FunctionExpression)
								) {
									methodCount++;
								}
						}
					});

					if (methodCount > 0) {
						didExtractLiteral = true;
					}

					if (didExtractLiteral) {
						ordinal++;
						let parentNode = liternalNode.parent;

						// Compute the name for assignments, call expressions and others
						let name = '';
						if (
							parentNode.kind == ts.SyntaxKind.VariableDeclaration ||
							parentNode.kind == ts.SyntaxKind.PropertyAssignment
						) {
							let parentNodeAsVariableDeclaration = parentNode as ts.Node & {
								name: ts.PropertyName;
							};
							name =
								getEscapedTextOfIdentifierOrLiteral(parentNodeAsVariableDeclaration.name) || '';
						} else if (parentNode.kind == ts.SyntaxKind.CallExpression) {
							let parentNodeAsCallExpression = parentNode as ts.CallExpression;
							name =
								(parentNodeAsCallExpression.expression &&
									parentNodeAsCallExpression.expression.getFullText().trim()) ||
								'';
							if (name) {
								let nameTokens = name.split('\n');
								name = nameTokens[nameTokens.length - 1];
								name = name + '()';
							}
						} else if (parentNode.kind == ts.SyntaxKind.BinaryExpression) {
							let parentNodeAsBinaryExpression = parentNode as ts.BinaryExpression;
							// Only handle these for assignments
							let sign: ts.BinaryOperatorToken = parentNodeAsBinaryExpression.operatorToken;
							if (ts.tokenToString(sign.kind) == '=') {
								let left = parentNodeAsBinaryExpression.left;
								let nameTokens;
								switch (left.kind) {
									case ts.SyntaxKind.VariableDeclaration:
										let leftVariableDeclaration = (left as unknown) as ts.VariableDeclaration;
										name = getEscapedTextOfIdentifierOrLiteral(leftVariableDeclaration.name) || '';
										break;
									case ts.SyntaxKind.PropertyAccessExpression:
										name = left.getFullText().trim();
										nameTokens = name.split('\n');
										name = nameTokens[nameTokens.length - 1];
										break;
								}
							}
						}

						tokens.push({
							name: name || '{}',
							kind: CodeOutlineTokenKind.ObjectLiteral,
							ordinal: ordinal,
							line: currentFile?.getLineAndCharacterOfPosition(liternalNode.getStart()).line || 0,
							indentAmount: indentation
						});
					}

					return didExtractLiteral;
				};

				const extractClass = function (classNode: ts.ClassDeclaration) {
					ordinal++;
					if (classNode.name) {
						tokens.push({
							name: getEscapedTextOfIdentifierOrLiteral(classNode.name) || '',
							kind: CodeOutlineTokenKind.Class,
							ordinal: ordinal,
							line: currentFile?.getLineAndCharacterOfPosition(classNode.getStart()).line || 0,
							indentAmount: indentation
						});
					} else {
						tokens.push({
							name: '{}',
							kind: CodeOutlineTokenKind.Class,
							ordinal: ordinal,
							line: currentFile?.getLineAndCharacterOfPosition(classNode.getStart()).line || 0,
							indentAmount: indentation
						});
					}
				};

				const extractMethod = function (methodNode: ts.FunctionLikeDeclaration) {
					ordinal++;
					let node = methodNode;
					let line = currentFile?.getLineAndCharacterOfPosition(methodNode.getStart()).line || 0;

					let parentNode = methodNode.parent;
					// isMethodKind is set to YES for function declarations whose parent is a property assignment
					let isMethodKind = false;

					// Compute the name for assignments
					let name = '';
					if (parentNode.kind == ts.SyntaxKind.PropertyAssignment) {
						let parentNodeAsPropertyAssignment = parentNode as ts.PropertyAssignment;
						name = getEscapedTextOfIdentifierOrLiteral(parentNodeAsPropertyAssignment.name) || '';
						isMethodKind = true;
					} else if (parentNode.kind == ts.SyntaxKind.VariableDeclaration) {
						let parentNodeAsVariableDeclaration = parentNode as ts.VariableDeclaration;
						name = getEscapedTextOfIdentifierOrLiteral(parentNodeAsVariableDeclaration.name) || '';
					} else if (parentNode.kind == ts.SyntaxKind.CallExpression) {
						let parentNodeAsCallExpression = parentNode as ts.CallExpression;
						name =
							(parentNodeAsCallExpression.expression &&
								parentNodeAsCallExpression.expression.getFullText().trim()) ||
							'';
						if (name) {
							let nameTokens = name.split('\n');
							name = nameTokens[nameTokens.length - 1].trim();
							name = name + '()';
						}
					} else if (parentNode.kind == ts.SyntaxKind.BinaryExpression) {
						// Only handle these for assignments
						let parentNodeAsBinaryExpression = parentNode as ts.BinaryExpression;
						let sign = parentNodeAsBinaryExpression.operatorToken;
						if (ts.tokenToString(sign.kind) == '=') {
							let left = parentNodeAsBinaryExpression.left;
							let nameTokens;
							switch (left.kind) {
								case ts.SyntaxKind.VariableDeclaration:
									let leftAsVariableDeclaration = (left as unknown) as ts.VariableDeclaration;
									name = getEscapedTextOfIdentifierOrLiteral(leftAsVariableDeclaration.name) || '';
									break;
								case ts.SyntaxKind.PropertyAccessExpression:
									name = left.getFullText().trim();
									nameTokens = name.split('\n');
									name = nameTokens[nameTokens.length - 1].trim();
									break;
							}
						}
					}

					switch (methodNode.kind) {
						case ts.SyntaxKind.Constructor:
							tokens.push({
								name: 'constructor ()',
								kind: CodeOutlineTokenKind.Constructor,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						case ts.SyntaxKind.MethodDeclaration:
							let nodeAsMethodDeclaration = node as ts.MethodDeclaration;
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(nodeAsMethodDeclaration.name) || '{}',
								kind: CodeOutlineTokenKind.Method,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						case ts.SyntaxKind.FunctionExpression:
						case ts.SyntaxKind.FunctionDeclaration:
							let nodeAsFunctionDeclaration = node as ts.FunctionExpression;
							tokens.push({
								name:
									getEscapedTextOfIdentifierOrLiteral(nodeAsFunctionDeclaration.name) ||
									name ||
									'{}',
								kind: isMethodKind ? CodeOutlineTokenKind.Method : CodeOutlineTokenKind.Function,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						case ts.SyntaxKind.GetAccessor:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || '()',
								kind: CodeOutlineTokenKind.Get,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						case ts.SyntaxKind.SetAccessor:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || '()',
								kind: CodeOutlineTokenKind.Set,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						case ts.SyntaxKind.ArrowFunction:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || name || '() => {}',
								kind: CodeOutlineTokenKind.Function,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							});
							break;
						default:
							break;
					}
				};

				const buildOutline = function (node: ts.Node): void {
					let didIndent = false;
					switch (node.kind) {
						case ts.SyntaxKind.ObjectLiteralExpression:
							if (extractLiteral(node as ts.ObjectLiteralExpression)) {
								indentation += 1;
								didIndent = true;
							}
							break;
						case ts.SyntaxKind.ClassExpression:
						case ts.SyntaxKind.ClassDeclaration:
							extractClass(node as ts.ClassDeclaration);
							indentation += 1;
							didIndent = true;
							break;
						case ts.SyntaxKind.MethodDeclaration:
						case ts.SyntaxKind.MethodSignature:
						case ts.SyntaxKind.FunctionDeclaration:
						case ts.SyntaxKind.FunctionExpression:
						case ts.SyntaxKind.GetAccessor:
						case ts.SyntaxKind.SetAccessor:
						case ts.SyntaxKind.Constructor:
						case ts.SyntaxKind.ArrowFunction:
							extractMethod(node as ts.FunctionLikeDeclaration);
							indentation += 1;
							didIndent = true;
							break;
						default:
							break;
					}

					ts.forEachChild(node, buildOutline);
					if (didIndent) indentation -= 1;
				};

				buildOutline(currentFile);
			}
		}
		return tokens;
	}
}

export interface ICreateData {
	compilerOptions: ts.CompilerOptions;
	extraLibs: IExtraLibs;
	customWorkerPath?: string;
}

/** The shape of the factory */
export interface CustomTSWebWorkerFactory {
	(
		TSWorkerClass: typeof TypeScriptWorker,
		tsc: typeof ts,
		libs: Record<string, string>
	): typeof TypeScriptWorker;
}

declare global {
	var importScripts: (path: string) => void | undefined;
	var customTSWorkerFactory: CustomTSWebWorkerFactory | undefined;
}

export function create(ctx: worker.IWorkerContext, createData: ICreateData): TypeScriptWorker {
	let TSWorkerClass = TypeScriptWorker;
	if (createData.customWorkerPath) {
		if (typeof importScripts === 'undefined') {
			console.warn(
				'Monaco is not using webworkers for background tasks, and that is needed to support the customWorkerPath flag'
			);
		} else {
			importScripts(createData.customWorkerPath);

			const workerFactoryFunc: CustomTSWebWorkerFactory | undefined = self.customTSWorkerFactory;
			if (!workerFactoryFunc) {
				throw new Error(
					`The script at ${createData.customWorkerPath} does not add customTSWorkerFactory to self`
				);
			}

			TSWorkerClass = workerFactoryFunc(TypeScriptWorker, ts, libFileMap);
		}
	}

	return new TSWorkerClass(ctx, createData);
}
