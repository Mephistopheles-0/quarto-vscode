/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RStudio, PBC. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as fs from "fs";

import {
  ExtensionContext,
  workspace,
  extensions,
  commands,
  window,
  MessageItem,
  ConfigurationTarget,
} from "vscode";
import { QuartoContext } from "../shared/quarto";
import { ensureGitignore } from "../core/git";
import { join } from "path";

export async function activateLuaTypes(
  context: ExtensionContext,
  quartoContext: QuartoContext
) {
  // check pref to see if we are syncing types
  const config = workspace.getConfiguration("quarto");
  if (config.get("lua.provideTypes") === false) {
    return;
  }

  // compute path to .luarc.json (make sure we have at least one worksapce folder)
  const luarc =
    workspace.workspaceFolders && workspace.workspaceFolders.length > 0
      ? path.join(workspace.workspaceFolders[0].uri.fsPath, ".luarc.json")
      : undefined;
  if (!luarc) {
    return;
  }

  // if we aren't prompting to install the lua extension then
  // check for it and bail if its not there
  if (!isLuaLspInstalled() && !canPromptForLuaLspInstall(context)) {
    return;
  }

  // check for glob in workspace
  const workspaceHasFile = async (glob: string) => {
    const kExclude = "**/{node_modules,renv,packrat,venv,env}/**";
    return (await workspace.findFiles(glob, kExclude, 10)).length > 0;
  };

  // check if we have quarto files
  if (
    (await workspaceHasFile("**/*.qmd")) ||
    (await workspaceHasFile("**/_quarto.{yml,yaml}")) ||
    (await workspaceHasFile("**/_extension.{yml,yaml}"))
  ) {
    if (await workspaceHasFile("**/*.lua")) {
      await syncLuaTypes(context, quartoContext, luarc);
    } else {
      const handler = workspace.onDidOpenTextDocument(
        async (e) => {
          if (path.extname(e.fileName) === ".lua") {
            if (workspace.asRelativePath(e.fileName) !== e.fileName) {
              await syncLuaTypes(context, quartoContext, luarc);
              handler.dispose();
            }
          }
        },
        null,
        context.subscriptions
      );
    }
  }
}

async function syncLuaTypes(
  context: ExtensionContext,
  quartoContext: QuartoContext,
  luarc: string
) {
  // if we don't have the extension that see if we should prompt to install it
  if (!isLuaLspInstalled() && canPromptForLuaLspInstall(context)) {
    const install: MessageItem = { title: "Install Now" };
    const notNow: MessageItem = { title: "Maybe Later" };
    const neverInstall: MessageItem = { title: "Don't Ask Again" };
    const result = await window.showInformationMessage<MessageItem>(
      "Quarto can provide completion and diagnostics for Lua scripts in this workspace if the " +
        "[Lua extension](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) " +
        "is installed. Do you want to install it now?",
      install,
      notNow,
      neverInstall
    );
    if (result === install) {
      await commands.executeCommand(
        "workbench.extensions.installExtension",
        "sumneko.lua"
      );
    } else {
      if (result === neverInstall) {
        preventPromptForLspInstall(context);
      }
      return;
    }
  }

  // constants
  const kGenerator = "Generator";
  const kWorkspaceLibrary = "Lua.workspace.library";
  const kRuntimePlugin = "Lua.runtime.plugin";

  // determine the path to the quarto lua types (bail if we don't have it)
  const luaTypesDir = path.join(quartoContext.resourcePath, "lua-types");
  if (!fs.existsSync(luaTypesDir) || !fs.statSync(luaTypesDir).isDirectory()) {
    return;
  }

  // if there are Lua libraries in the workspace then bail
  const luaConfig = workspace.getConfiguration("Lua");
  const inspectLibrary = luaConfig.inspect("workspace.library");
  if (inspectLibrary?.workspaceValue || inspectLibrary?.workspaceFolderValue) {
    return;
  }

  // read base luarc (provide default if there is none)
  const kDefaultLuaRc = {
    [kGenerator]: [
      "Quarto",
      "This file provides type information for Lua completion and diagnostics.",
      "Quarto will automatically update this file to reflect the current path",
      "of your Quarto installation, and the file will also be added to .gitignore",
      "since it points to the absolute path of Quarto on the local system.",
      "Remove the 'Generator' key to manage this file's contents manually.",
    ],
    "Lua.runtime.version": "Lua 5.3",
    "Lua.workspace.checkThirdParty": false,
    [kWorkspaceLibrary]: [],
    [kRuntimePlugin]: "",
    "Lua.diagnostics.disable": ["lowercase-global", "trailing-space"],
  };
  const luarcJson = (
    fs.existsSync(luarc)
      ? JSON.parse(fs.readFileSync(luarc, { encoding: "utf-8" }))
      : kDefaultLuaRc
  ) as Record<string, unknown>;

  // if there is no generator then leave it alone
  if (luarcJson[kGenerator] === undefined) {
    return;
  }

  // see if we need to make any updates
  let rewriteLuarc = false;

  // if the current workspace library is out of sync then change it and re-write
  if (
    JSON.stringify(luarcJson[kWorkspaceLibrary]) !==
    JSON.stringify([luaTypesDir])
  ) {
    luarcJson[kWorkspaceLibrary] = [luaTypesDir];
    rewriteLuarc = true;
  }

  // if the current Lua.runtime.plugin is out of sync then change it and re-write
  const pluginPath = join(luaTypesDir, "plugin.lua");
  if (fs.existsSync(pluginPath)) {
    if (pluginPath !== luarcJson[kRuntimePlugin]) {
      luarcJson[kRuntimePlugin] = pluginPath;
      rewriteLuarc = true;
    }
  }

  // rewrite if we need to
  if (rewriteLuarc) {
    fs.writeFileSync(luarc, JSON.stringify(luarcJson, undefined, 2));
  }

  // fix issue w/ git protocol
  await ensureNoGitScheme();

  // ensure gitignore
  ensureGitignore(path.dirname(luarc), ["/" + path.basename(luarc)]);
}

// git scheme doesn't have our folder level settings so all of the
// implicit pandoc globals show up as 'undefined global'. it looks
// like the Lua plugin already attempts to disable diagnostics by
// default for "git" protocol but it doesn't seem to work in current
// versions of VS Code. Here we set a more sensible default (but
// only if the user hasn't explicitly interacted with this setting)
async function ensureNoGitScheme() {
  const luaConfig = workspace.getConfiguration("Lua");
  const inspectSupportScheme = luaConfig.inspect("workspace.supportScheme");
  if (
    !inspectSupportScheme?.globalValue &&
    !inspectSupportScheme?.workspaceValue &&
    !inspectSupportScheme?.workspaceFolderValue
  ) {
    await luaConfig.update(
      "workspace.supportScheme",
      ["file", "default"],
      ConfigurationTarget.Global
    );
  }
}

const kPromptForLuaLspInstall = "quarto.lua.promptLspInstall";

function isLuaLspInstalled() {
  return extensions.getExtension("sumneko.lua") !== undefined;
}

function canPromptForLuaLspInstall(context: ExtensionContext) {
  return context.workspaceState.get<boolean>(kPromptForLuaLspInstall) !== false;
}

function preventPromptForLspInstall(context: ExtensionContext) {
  context.workspaceState.update(kPromptForLuaLspInstall, false);
}
