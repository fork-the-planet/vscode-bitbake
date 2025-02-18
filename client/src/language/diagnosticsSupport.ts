/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode'

import { getOriginalDocRange } from './utils/embeddedLanguagesUtils'
import { embeddedLanguageDocsManager } from './EmbeddedLanguageDocsManager'
import { type EmbeddedLanguageType } from '../lib/src/types/embedded-languages'
import { requestsManager } from '../language/RequestManager'
import path from 'path'
import { logger } from '../lib/src/utils/OutputLogger'
import { commonDirectoriesVariables } from '../lib/src/availableVariables'

// Supported external sources (VS Code extensions) that might generate diagnostics if installed.
const supportedSources = ['Flake8', 'Pylance', 'Pylint', 'shellcheck']

const diagnosticCollections = {
  bash: vscode.languages.createDiagnosticCollection('bitbake-bash'),
  python: vscode.languages.createDiagnosticCollection('bitbake-python')
}

// Create diagnostics for an "original document" from the diagnostics of its "embedded language documents"
// It ignores the uris for documents that are not "embedded language documents"
export const updateDiagnostics = async (uri: vscode.Uri): Promise<void> => {
  logger.debug(`[updateDiagnostics] for uri: ${uri.toString()}`)
  const embeddedLanguageType = getEmbeddedLanguageType(uri)
  if (embeddedLanguageType === undefined) {
    return
  }
  const originalUri = embeddedLanguageDocsManager.getOriginalUri(uri)
  if (originalUri === undefined) {
    return
  }
  const originalTextDocument = vscode.workspace.textDocuments.find((textDocument) => textDocument.uri.toString() === originalUri.toString())
  if (originalTextDocument === undefined) {
    // The original TextDocument is probably closed. Thus the user would not see the diagnostics anyway.
    // We don't attempt to reopen it. We were previously doing so, and it was causing trouble. Here what we assume was going on:
    // At first everything looked fine, but it became an issue when too many files had been opened (around thirty).
    // The oldest files were being "garbage collected", then immediately reopened, which would cause the next oldest files to be "garbage collected", and so on.
    // The whole thing would create lot of flickering in the diagnostics, and make the extension slow.
    return
  }

  const embeddedLanguageDocInfos = embeddedLanguageDocsManager.getEmbeddedLanguageDocInfos(
    originalTextDocument.uri,
    embeddedLanguageType
  )
  if (embeddedLanguageDocInfos === undefined) {
    return
  }
  const embeddedLanguageDoc = await vscode.workspace.openTextDocument(embeddedLanguageDocInfos.uri.fsPath)
  const dirtyDiagnostics = vscode.languages.getDiagnostics(embeddedLanguageDocInfos.uri)
  const cleanDiagnostics: vscode.Diagnostic[] = []
  const diagnosticCollection = diagnosticCollections[embeddedLanguageType]

  await Promise.all(dirtyDiagnostics.map(async (diagnostic) => {
    if (!checkHasSupportedSource(diagnostic)) {
      return
    }
    const adjustedRange = getOriginalDocRange(
      originalTextDocument,
      embeddedLanguageDoc,
      embeddedLanguageDocInfos.characterIndexes,
      diagnostic.range
    )
    if (adjustedRange === undefined) {
      return
    }

    const embeddedLanguageTypeOnPosition = await requestsManager.getEmbeddedLanguageTypeOnPosition(
      originalTextDocument.uri.toString(),
      adjustedRange.end
    )
    if (embeddedLanguageType !== embeddedLanguageTypeOnPosition) {
      // Diagnostics that are not on a region of the same embedded language are not relevant.
      return
    }

    if (await checkIsIgnoredDiagnostic(diagnostic, originalTextDocument, adjustedRange)) {
      return
    }
    const adjustedDiagnostic = {
      ...diagnostic,
      message: fixDiagnosticMessagePythonImport(diagnostic),
      range: adjustedRange,
      source: `${diagnostic.source}, ${diagnosticCollection.name}`
    }
    cleanDiagnostics.push(adjustedDiagnostic)
  }))
  diagnosticCollection.set(originalTextDocument.uri, cleanDiagnostics)
}

// Regenerate diagnostics for all "original documents" that already have diagnostics
// This is intended to be called when a new scan finished, so diagnostics can be updated with the available information.
export const reviewDiagnostics = async (): Promise<void> => {
  logger.debug('[reviewDiagnostics]')
  const allDiagnostics = vscode.languages.getDiagnostics()
  await Promise.all(allDiagnostics.map(async ([uri]): Promise<void> => {
    // uri might be for an "original document", an "embedded language document", and even something else.
    // updateDiagnostics ignores the uris that are not for an "embedded language documents"
    await updateDiagnostics(uri)
  }))
}

const getEmbeddedLanguageType = (uri: vscode.Uri): EmbeddedLanguageType | undefined => {
  const fileExtension = path.extname(uri.fsPath)
  if (fileExtension === '.py') {
    return 'python'
  }
  if (fileExtension === '.sh') {
    return 'bash'
  }
  return undefined
}

const checkIsIgnoredDiagnostic = async (
  diagnostic: vscode.Diagnostic,
  originalTextDocument: vscode.TextDocument,
  adjustedRange: vscode.Range
): Promise<boolean> => {
  if (await checkIsAlwaysIgnoredDiagnostic(diagnostic)) {
    return true
  }
  if (await checkIsIgnoredDiagnosticOnAnonymousFunctionFirstLine(diagnostic)) {
    return true
  }
  if (await checkIsIgnoredDiagnosticOnPythonUndefinedVariable(diagnostic, originalTextDocument, adjustedRange)) {
    return true
  }
  if (await checkIsIgnoredShellcheckSc2154(diagnostic, originalTextDocument, adjustedRange)) {
    return true
  }
  return false
}

const checkHasSupportedSource = (diagnostic: vscode.Diagnostic): boolean => {
  return supportedSources.some(
    (supportedSource) => diagnostic.source !== undefined && diagnostic.source.includes(supportedSource)
  )
}

const checkIsAlwaysIgnoredDiagnostic = async (
  diagnostic: vscode.Diagnostic
): Promise<boolean> => {
  if (
    hasSourceWithCode(diagnostic, 'Flake8', 'W391') || // blank line at end of file
    hasSourceWithCode(diagnostic, 'Pylint', 'C0114:missing-module-docstring') ||
    hasSourceWithCode(diagnostic, 'Pylint', 'C0116:missing-function-docstring') ||
    hasSourceWithCode(diagnostic, 'Pylint', 'C0305:trailing-newlines') ||
    hasSourceWithCode(diagnostic, 'Pylint', 'C0415:import-outside-toplevel') ||

    // From here, diagnostics we'd rather not always ignore, but which would require a call to the language server to check for their context.
    // We're concerned making too many requests might cause performance issues.

    // Should be ignored only on inline Python
    hasSourceWithCode(diagnostic, 'Flake8', 'E501') || // Line too long
    hasSourceWithCode(diagnostic, 'Pylint', 'W0104:pointless-statement') ||
    hasSourceWithCode(diagnostic, 'Pylint', 'W0106:expression-not-assigned') ||
    // Should be ignored only on first line of python anonymous function
    hasSourceWithCode(diagnostic, 'Flake8', 'E203') || // whitespace before ':'
    hasSourceWithCode(diagnostic, 'Flake8', 'E211') || // whitespace before '('
    // Should be ignored only on first line of python anonymous function and first line of Python function
    hasSourceWithCode(diagnostic, 'Flake8', 'E302') || // expected 2 blank lines, found 1
    // Should be ignored only on inline Python, first line of anonymous python function, and first line of Python function
    hasSourceWithCode(diagnostic, 'Flake8', 'E303') // too many blank lines
  ) {
    return true
  }
  return false
}

const checkIsIgnoredDiagnosticOnAnonymousFunctionFirstLine = async (
  diagnostic: vscode.Diagnostic
): Promise<boolean> => {
  if (
    diagnostic.source?.includes('Pylance') === true &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (diagnostic as any)?.hasDiagnosticCode === false && // This weird diagnostic has no code but such a property
    diagnostic.message === '"__anonymous" is not accessed') {
    return true
  }
  return false
}

const checkIsIgnoredDiagnosticOnPythonUndefinedVariable = async (
  diagnostic: vscode.Diagnostic,
  originalTextDocument: vscode.TextDocument,
  adjustedRange: vscode.Range
): Promise<boolean> => {
  if (
    !hasSourceWithCode(diagnostic, 'Flake8', 'F821') &&
    !hasSourceWithCode(diagnostic, 'Pylance', 'reportUndefinedVariable') &&
    !hasSourceWithCode(diagnostic, 'Pylint', 'E0602:undefined-variable')
  ) {
    return false
  }

  const definition = await requestsManager.getDefinition(
    originalTextDocument,
    new vscode.Position(adjustedRange.start.line, adjustedRange.start.character + 1)
  )
  return definition.length > 0
}

const checkIsIgnoredShellcheckSc2154 = async (
  diagnostic: vscode.Diagnostic,
  originalTextDocument: vscode.TextDocument,
  adjustedRange: vscode.Range
): Promise<boolean> => {
  if (!hasSourceWithCode(diagnostic, 'shellcheck', 'SC2154')) {
    return false
  }

  const position = (() => {
    // In variable expansions, the range includes the curly brace at its end and potentially whitespaces.
    // We get position of the last alphanumeric character in the range.
    const textOnRange = originalTextDocument.getText(adjustedRange)
    const match = textOnRange.match(/\w+/)
    if (match?.index === undefined) {
      logger.error('[checkIsIgnoredShellcheckSc2154] Could not find a word on the range')
      return adjustedRange.end // This should not happen
    }
    if (match.index === 0) {
      return adjustedRange.end // The range does not include braces
    }
    const actualVariable = match[0]
    const actualEndOfVariable = adjustedRange.start.character + match.index + actualVariable.length
    return new vscode.Position(adjustedRange.end.line, actualEndOfVariable)
  })()

  const definition = await requestsManager.getDefinition(originalTextDocument, position)
  if (definition.length > 0) {
    return true
  }

  // Maybe the scan has not be done yet.
  // In that case, as a fallback, we check if the variable exists in static list of common directories.
  const message = diagnostic.message
  const match = message.match(/^(?<variableName>\w+) is referenced but not assigned\.$/)
  const variableName = match?.groups?.variableName
  return commonDirectoriesVariables.has(variableName as string)
}

const fixDiagnosticMessagePythonImport = (
  diagnostic: vscode.Diagnostic
): string => {
  // Some imports are made automatically by BitBake. Reimporting them produces a warning with irrelevant line number.
  const fix = (regex: RegExp): string => {
    const embeddedLanguageDocImportLine = 7 // In the embedded language document, the imports are from that line or before.
    const newText = ' (imported by BitBake)'
    const match = diagnostic.message.match(regex)
    const lineNumber = Number(match?.groups?.lineNumber)
    const textToRemoveLength = match?.groups?.textToRemove?.length
    if (lineNumber !== undefined && lineNumber <= embeddedLanguageDocImportLine && textToRemoveLength !== undefined) {
      return diagnostic.message.slice(0, diagnostic.message.length - textToRemoveLength) + newText
    }
    return diagnostic.message
  }
  if (hasSourceWithCode(diagnostic, 'Flake8', 'F811')) {
    return fix(/redefinition of unused '(?:\w+)'(?<textToRemove> from line (?<lineNumber>\d+))/)
  }
  if (hasSourceWithCode(diagnostic, 'Pylint', 'W0404:reimported')) {
    return fix(/Reimport '(?:\w+)'(?<textToRemove> \(imported line (?<lineNumber>\d+)\))/)
  }
  if (hasSourceWithCode(diagnostic, 'Pylint', 'W0621:redefined-outer-name')) {
    return fix(/Redefining name '(?:\w+)'(?<textToRemove> from outer scope \(line (?<lineNumber>\d+)\))/)
  }
  return diagnostic.message
}

const hasSourceWithCode = (diagnostic: vscode.Diagnostic, source: string, code: string): boolean => {
  if (diagnostic.source?.includes(source) !== true) {
    return false
  }
  if (diagnostic.code === code) {
    return true
  }
  if (typeof diagnostic.code === 'object' && diagnostic.code?.value === code) {
    return true
  }
  return false
}
