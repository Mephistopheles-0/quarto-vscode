/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RStudio, PBC. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// TODO: implement some terminal based executors
// (e.g. see https://github.com/JeepShen/vscode-markdown-code-runner)

import semver from "semver";

import Token from "markdown-it/lib/token";
import { commands, extensions, Position, TextDocument, window } from "vscode";
import { MarkdownEngine } from "../../markdown/engine";
import {
  isExecutableLanguageBlock,
  isExecutableLanguageBlockOf,
  languageNameFromBlock,
} from "../../markdown/language";
import { virtualDoc, virtualDocUri } from "../../vdoc/vdoc";

export function hasExecutor(language: string) {
  return !!kCellExecutors.find((x) => x.language === language);
}

export function blockHasExecutor(token?: Token) {
  if (token) {
    const language = languageNameFromBlock(token);
    return isExecutableLanguageBlock(token) && hasExecutor(language);
  } else {
    return false;
  }
}

export async function executeInteractive(
  language: string,
  code: string
): Promise<void> {
  const executor = kCellExecutors.find((x) => x.language === language);
  if (executor) {
    return await executor.execute(code);
  }
}

export function hasCellExecutor(language: string) {
  return !!kCellExecutors.find((x) => x.language === language);
}

// ensure language extension is loaded (if required) by creating a
// virtual doc for the language (under the hood this triggers extension
// loading by sending a dummy hover-provider request)
const kLoadedLanguageExtensions: string[] = [];
export async function ensureRequiredExtension(
  language: string,
  document: TextDocument,
  engine: MarkdownEngine
): Promise<boolean> {
  // only do this once per language
  if (kLoadedLanguageExtensions.includes(language)) {
    return true;
  }

  const executor = kCellExecutors.find((x) => x.language === language);
  if (executor) {
    // validate the extension
    if (!validateRequiredExtension(executor)) {
      return false;
    }

    // load a virtual doc for this file (forces extension to load)
    const tokens = await engine.parse(document);
    const languageBlock = tokens.find(isExecutableLanguageBlockOf(language));
    if (languageBlock?.map) {
      const vdoc = await virtualDoc(
        document,
        new Position(languageBlock.map[0] + 1, 0),
        engine
      );
      if (vdoc) {
        // get the virtual doc
        await virtualDocUri(vdoc, document.uri);

        // mark language as being loaded
        kLoadedLanguageExtensions.push(executor.language);

        // success!!
        return true;
      }
    }
  }

  //  unable to validate
  return false;
}

function validateRequiredExtension(executor: CellExecutor) {
  if (executor.requiredExtension) {
    const extensionName =
      executor.requiredExtensionName || executor.requiredExtension;
    const extension = extensions.getExtension(executor?.requiredExtension);
    if (extension) {
      if (executor?.requiredVersion) {
        const version = (extension.packageJSON.version || "0.0.0") as string;
        if (semver.gte(version, executor.requiredVersion)) {
          return true;
        } else {
          window.showWarningMessage(
            `Executing ${executor.language} cells requires v${executor.requiredVersion} of the ${extensionName} extension.`
          );
          return false;
        }
      } else {
        return true;
      }
    } else {
      window.showWarningMessage(
        `Executing ${executor.language} cells requires the ${extensionName} extension.`
      );
      return false;
    }
  } else {
    return true;
  }
}

interface CellExecutor {
  language: string;
  requiredExtension?: string;
  requiredExtensionName?: string;
  requiredVersion?: string;
  execute: (code: string) => Promise<void>;
}

const pythonCellExecutor: CellExecutor = {
  language: "python",
  requiredExtension: "ms-python.python",
  requiredExtensionName: "Python",
  requiredVersion: "2021.8.0",
  execute: async (code: string) => {
    await commands.executeCommand("jupyter.execSelectionInteractive", code);
  },
};

const rCellExecutor: CellExecutor = {
  language: "r",
  requiredExtension: "Ikuyadeu.r",
  requiredExtensionName: "R",
  requiredVersion: "2.4.0",
  execute: async (code: string) => {
    await commands.executeCommand("r.runSelection", code);
  },
};

const juliaCellExecutor: CellExecutor = {
  language: "julia",
  requiredExtension: "julialang.language-julia",
  requiredExtensionName: "Julia",
  requiredVersion: "1.4.0",
  execute: async (code: string) => {
    const extension = extensions.getExtension("julialang.language-julia");
    if (extension) {
      extension.exports.executeInREPL(code, {});
    } else {
      window.showErrorMessage("Unable to execute code in Julia REPL");
    }
  },
};

const kCellExecutors = [pythonCellExecutor, rCellExecutor, juliaCellExecutor];
