/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as ts from './lib/typescriptServices';
import { lib_dts, lib_es6_dts } from './lib/lib';
import { IExtraLibs } from './monaco.contribution';

import IWorkerContext = monaco.worker.IWorkerContext;

const DEFAULT_LIB = {
	NAME: 'defaultLib:lib.d.ts',
	CONTENTS: lib_dts
};

const ES6_LIB = {
	NAME: 'defaultLib:lib.es6.d.ts',
	CONTENTS: lib_es6_dts
};

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

export class TypeScriptWorker implements ts.LanguageServiceHost {

	// --- model sync -----------------------

	private _ctx: IWorkerContext;
	private _extraLibs: IExtraLibs = Object.create(null);
	private _languageService = ts.createLanguageService(this);
	private _compilerOptions: ts.CompilerOptions;

	constructor(ctx: IWorkerContext, createData: ICreateData) {
		this._ctx = ctx;
		this._compilerOptions = createData.compilerOptions;
		this._extraLibs = createData.extraLibs;
	}

	// --- language service host ---------------

	getCompilationSettings(): ts.CompilerOptions {
		return this._compilerOptions;
	}

	getScriptFileNames(): string[] {
		let models = this._ctx.getMirrorModels().map(model => model.uri.toString());
		return models.concat(Object.keys(this._extraLibs));
	}

	private _getModel(fileName: string): monaco.worker.IMirrorModel | null {
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

	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		let text: string;
		let model = this._getModel(fileName);
		if (model) {
			// a true editor model
			text = model.getValue();

		} else if (fileName in this._extraLibs) {
			// extra lib
			text = this._extraLibs[fileName].content;

		} else if (fileName === DEFAULT_LIB.NAME) {
			text = DEFAULT_LIB.CONTENTS;
		} else if (fileName === ES6_LIB.NAME) {
			text = ES6_LIB.CONTENTS;
		} else {
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
			case 'ts': return ts.ScriptKind.TS;
			case 'tsx': return ts.ScriptKind.TSX;
			case 'js': return ts.ScriptKind.JS;
			case 'jsx': return ts.ScriptKind.JSX;
			default: return this.getCompilationSettings().allowJs
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
		}
	}

	getCurrentDirectory(): string {
		return '';
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		// TODO@joh support lib.es7.d.ts
		return (options.target || ts.ScriptTarget.ES5) <= ts.ScriptTarget.ES5 ? DEFAULT_LIB.NAME : ES6_LIB.NAME;
	}

	isDefaultLibFileName(fileName: string): boolean {
		return fileName === this.getDefaultLibFileName(this._compilerOptions);
	}

	// --- language features

	private static clearFiles(diagnostics: ts.Diagnostic[]) {
		// Clear the `file` field, which cannot be JSON'yfied because it
		// contains cyclic data structures.
		diagnostics.forEach(diag => {
			diag.file = undefined;
			const related = <ts.Diagnostic[]>diag.relatedInformation;
			if (related) {
				related.forEach(diag2 => diag2.file = undefined);
			}
		});
	}

	getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
		const diagnostics = this._languageService.getSyntacticDiagnostics(fileName);
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.resolve(diagnostics);
	}

	getSemanticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
		const diagnostics = this._languageService.getSemanticDiagnostics(fileName);
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.resolve(diagnostics);
	}

	getSuggestionDiagnostics(fileName: string): Promise<ts.DiagnosticWithLocation[]> {
		const diagnostics = this._languageService.getSuggestionDiagnostics(fileName);
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.resolve(diagnostics);
	}

	getCompilerOptionsDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
		const diagnostics = this._languageService.getCompilerOptionsDiagnostics();
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.resolve(diagnostics);
	}

	getCompletionsAtPosition(fileName: string, position: number): Promise<ts.CompletionInfo | undefined> {
		return Promise.resolve(this._languageService.getCompletionsAtPosition(fileName, position, undefined));
	}

	getCompletionEntryDetails(fileName: string, position: number, entry: string): Promise<ts.CompletionEntryDetails | undefined> {
		return Promise.resolve(this._languageService.getCompletionEntryDetails(fileName, position, entry, undefined, undefined, undefined));
	}

	getSignatureHelpItems(fileName: string, position: number): Promise<ts.SignatureHelpItems | undefined> {
		return Promise.resolve(this._languageService.getSignatureHelpItems(fileName, position, undefined));
	}

	getQuickInfoAtPosition(fileName: string, position: number): Promise<ts.QuickInfo | undefined> {
		return Promise.resolve(this._languageService.getQuickInfoAtPosition(fileName, position));
	}

	getOccurrencesAtPosition(fileName: string, position: number): Promise<ReadonlyArray<ts.ReferenceEntry> | undefined> {
		return Promise.resolve(this._languageService.getOccurrencesAtPosition(fileName, position));
	}

	getDefinitionAtPosition(fileName: string, position: number): Promise<ReadonlyArray<ts.DefinitionInfo> | undefined> {
		return Promise.resolve(this._languageService.getDefinitionAtPosition(fileName, position));
	}

	getReferencesAtPosition(fileName: string, position: number): Promise<ts.ReferenceEntry[] | undefined> {
		return Promise.resolve(this._languageService.getReferencesAtPosition(fileName, position));
	}

	getNavigationBarItems(fileName: string): Promise<ts.NavigationBarItem[]> {
		return Promise.resolve(this._languageService.getNavigationBarItems(fileName));
	}

	getFormattingEditsForDocument(fileName: string, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.resolve(this._languageService.getFormattingEditsForDocument(fileName, options));
	}

	getFormattingEditsForRange(fileName: string, start: number, end: number, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.resolve(this._languageService.getFormattingEditsForRange(fileName, start, end, options));
	}

	getFormattingEditsAfterKeystroke(fileName: string, postion: number, ch: string, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.resolve(this._languageService.getFormattingEditsAfterKeystroke(fileName, postion, ch, options));
	}

	findRenameLocations(fileName: string, positon: number, findInStrings: boolean, findInComments: boolean, providePrefixAndSuffixTextForRename: boolean): Promise<readonly ts.RenameLocation[] | undefined> {
		return Promise.resolve(this._languageService.findRenameLocations(fileName, positon, findInStrings, findInComments, providePrefixAndSuffixTextForRename));
	}

	getRenameInfo(fileName: string, positon: number, options: ts.RenameInfoOptions): Promise<ts.RenameInfo> {
		return Promise.resolve(this._languageService.getRenameInfo(fileName, positon, options));
	}

	getEmitOutput(fileName: string): Promise<ts.EmitOutput> {
		return Promise.resolve(this._languageService.getEmitOutput(fileName));
	}

	getPropertiesOrAttributesOf(fileName: string, parentObjects: string[]): { [name: string]: { [name: string]: boolean } } {
		let referencedEntities: { [name: string]: { [name: string]: boolean } } = {};
		parentObjects.forEach(function (key) { referencedEntities[key] = {}; });
		let program = this._languageService.getProgram();
		if (program) {
			let currentFile = program.getSourceFile(fileName);
			if (currentFile) {
				let typeChecker = program.getTypeChecker();

				ts.forEachChild(currentFile, function visitNodes(node: ts.Node) {
					if (ts.isPropertyAccessExpression(node) && referencedEntities[node.expression.getText()]) {
						// Matches Things.test
						if (!(node.name.text in referencedEntities[node.expression.getText()])) {
							referencedEntities[node.expression.getText()][node.name.text] = true;
						}
					} else if (ts.isElementAccessExpression(node) && referencedEntities[node.expression.getText()] && node.argumentExpression) {
						if (node.argumentExpression.kind == ts.SyntaxKind.Identifier) {
							if (node.expression.getText() == "Users" && node.argumentExpression.getText() == "principal") {
								// a special case for Users[principal] => replace principal with "Administrator",
								// since all users have the same properties and functions
								referencedEntities["Users"]["System"] = true;
							}
						}
						if (node.argumentExpression.kind == ts.SyntaxKind.PropertyAccessExpression) {
							// matches Things[me.property]
							let type = typeChecker.getTypeAtLocation(node.argumentExpression);
							if ('value' in type) {
								referencedEntities[node.expression.getText()][type["value"]] = true;
							}
						} else if (ts.isStringLiteral(node.argumentExpression)) {
							// matches Things["test"]
							referencedEntities[node.expression.getText()][node.argumentExpression.getText().slice(1, -1)] = true;
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

				const getEscapedTextOfIdentifierOrLiteral = function (node?: { kind: ts.SyntaxKind, escapedText?: ts.__String, text?: string }): string | undefined {
					if(node) {
						return node.kind === ts.SyntaxKind.Identifier ? node.escapedText as string : node.text;
					}
				}

				const extractLiteral = (liternalNode: ts.ObjectLiteralExpression) => {
					let didExtractLiteral = false;

					// Object literals should only be extracted if they have at least a method or any getter/setter
					let methodCount = 0;
					liternalNode.properties.forEach(property => {
						switch (property.kind) {
							case ts.SyntaxKind.MethodDeclaration:
								methodCount++;
								break;
							case ts.SyntaxKind.GetAccessor:
							case ts.SyntaxKind.SetAccessor:
								didExtractLiteral = true;
								break;
							case ts.SyntaxKind.PropertyAssignment:
								if (property.initializer &&
									(property.initializer.kind == ts.SyntaxKind.FunctionDeclaration || property.initializer.kind == ts.SyntaxKind.FunctionExpression)) {
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
						if (parentNode.kind == ts.SyntaxKind.VariableDeclaration || parentNode.kind == ts.SyntaxKind.PropertyAssignment) {
							let parentNodeAsVariableDeclaration = parentNode as ts.Node & { name: ts.PropertyName };
							name = getEscapedTextOfIdentifierOrLiteral(parentNodeAsVariableDeclaration.name) || '';
						}
						else if (parentNode.kind == ts.SyntaxKind.CallExpression) {
							let parentNodeAsCallExpression = parentNode as ts.CallExpression;
							name = (parentNodeAsCallExpression.expression && parentNodeAsCallExpression.expression.getFullText().trim()) || '';
							if (name) {
								let nameTokens = name.split('\n');
								name = nameTokens[nameTokens.length - 1];
								name = name + '()';
							}
						}
						else if (parentNode.kind == ts.SyntaxKind.BinaryExpression) {
							let parentNodeAsBinaryExpression = parentNode as ts.BinaryExpression;
							// Only handle these for assignments
							let sign: ts.BinaryOperatorToken = parentNodeAsBinaryExpression.operatorToken;
							if (ts.tokenToString(sign.kind) == '=') {
								let left = parentNodeAsBinaryExpression.left;
								let nameTokens;
								switch (left.kind) {
									case ts.SyntaxKind.VariableDeclaration:
										let leftVariableDeclaration = left as unknown as ts.VariableDeclaration;
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
				}

				const extractClass = function (classNode: ts.ClassDeclaration) {
					ordinal++;
					if (classNode.name) {
						tokens.push({
							name: getEscapedTextOfIdentifierOrLiteral(classNode.name) || "",
							kind: CodeOutlineTokenKind.Class,
							ordinal: ordinal,
							line: currentFile?.getLineAndCharacterOfPosition(classNode.getStart()).line || 0,
							indentAmount: indentation
						});
					}
					else {
						tokens.push({
							name: '{}',
							kind: CodeOutlineTokenKind.Class,
							ordinal: ordinal,
							line: currentFile?.getLineAndCharacterOfPosition(classNode.getStart()).line || 0,
							indentAmount: indentation
						});
					}
				}

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
					}
					else if (parentNode.kind == ts.SyntaxKind.VariableDeclaration) {
						let parentNodeAsVariableDeclaration = parentNode as ts.VariableDeclaration;
						name = getEscapedTextOfIdentifierOrLiteral(parentNodeAsVariableDeclaration.name) || '';
					}
					else if (parentNode.kind == ts.SyntaxKind.CallExpression) {
						let parentNodeAsCallExpression = parentNode as ts.CallExpression;
						name = (parentNodeAsCallExpression.expression && parentNodeAsCallExpression.expression.getFullText().trim()) || '';
						if (name) {
							let nameTokens = name.split('\n');
							name = nameTokens[nameTokens.length - 1].trim();
							name = name + '()';
						}
					}
					else if (parentNode.kind == ts.SyntaxKind.BinaryExpression) {
						// Only handle these for assignments
						let parentNodeAsBinaryExpression = parentNode as ts.BinaryExpression;
						let sign = parentNodeAsBinaryExpression.operatorToken;
						if (ts.tokenToString(sign.kind) == '=') {
							let left = parentNodeAsBinaryExpression.left;
							let nameTokens;
							switch (left.kind) {
								case ts.SyntaxKind.VariableDeclaration:
									let leftAsVariableDeclaration = left as unknown as ts.VariableDeclaration;
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
							})
							break;
						case ts.SyntaxKind.MethodDeclaration:
							let nodeAsMethodDeclaration = node as ts.MethodDeclaration;
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(nodeAsMethodDeclaration.name) || '{}',
								kind: CodeOutlineTokenKind.Method,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							})
							break;
						case ts.SyntaxKind.FunctionExpression:
						case ts.SyntaxKind.FunctionDeclaration:
							let nodeAsFunctionDeclaration = node as ts.FunctionExpression;
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(nodeAsFunctionDeclaration.name) || name || '{}',
								kind: isMethodKind ? CodeOutlineTokenKind.Method : CodeOutlineTokenKind.Function,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							})
							break;
						case ts.SyntaxKind.GetAccessor:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || '()',
								kind: CodeOutlineTokenKind.Get,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							})
							break;
						case ts.SyntaxKind.SetAccessor:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || '()',
								kind: CodeOutlineTokenKind.Set,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							})
							break;
						case ts.SyntaxKind.ArrowFunction:
							tokens.push({
								name: getEscapedTextOfIdentifierOrLiteral(node.name) || name || '() => {}',
								kind: CodeOutlineTokenKind.Function,
								ordinal: ordinal,
								line: line,
								indentAmount: indentation
							})
							break;
						default:
							break;
					}
				}

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
				}

				buildOutline(currentFile);
			}
		}
		return tokens;
	}
	getCodeFixesAtPosition(fileName: string, start: number, end: number, errorCodes: number[], formatOptions: ts.FormatCodeOptions): Promise<ReadonlyArray<ts.CodeFixAction>> {
		const preferences = {}
		return Promise.resolve(this._languageService.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences));
	}

	updateExtraLibs(extraLibs: IExtraLibs) {
		this._extraLibs = extraLibs;
	}
}

export interface ICreateData {
	compilerOptions: ts.CompilerOptions;
	extraLibs: IExtraLibs;
}

export function create(ctx: IWorkerContext, createData: ICreateData): TypeScriptWorker {
	return new TypeScriptWorker(ctx, createData);
}
