/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RStudio, PBC. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as fs from "fs";
import * as uuid from "uuid";
import axios from "axios";

import vscode, {
  commands,
  env,
  ExtensionContext,
  MessageItem,
  Terminal,
  TerminalOptions,
  TextDocument,
  TextEditor,
  Selection,
  Range,
  Uri,
  ViewColumn,
  window,
  Position,
  TextEditorRevealType,
  NotebookDocument,
} from "vscode";
import { QuartoContext } from "../../shared/quarto";
import { previewCommands } from "./commands";
import { Command } from "../../core/command";
import {
  findEditor,
  isNotebook,
  isQuartoDoc,
  preserveEditorFocus,
  validatateQuartoExtension,
} from "../../core/doc";
import { PreviewOutputSink } from "./preview-output";
import { isHtmlContent, isTextContent, isPdfContent } from "../../core/mime";

import * as tmp from "tmp";
import {
  PreviewEnv,
  PreviewEnvManager,
  previewEnvsEqual,
  requiresTerminalDelay,
} from "./preview-env";
import { isHugoMarkdown } from "../../core/hugo";
import { MarkdownEngine } from "../../markdown/engine";
import { shQuote, winShEscape } from "../../shared/strings";

import {
  QuartoPreviewWebview,
  QuartoPreviewWebviewManager,
} from "./preview-webview";
import {
  isQuartoShinyDoc,
  previewDirForDocument,
  renderOnSave,
} from "./preview-util";
import { sleep } from "../../core/wait";
import { fileCrossrefIndexStorage } from "../../shared/storage";
import { normalizeNewlines } from "../../core/text";
import { vsCodeWebUrl } from "../../core/platform";

import {
  jupyterErrorLocation,
  knitrErrorLocation,
  luaErrorLocation,
  yamlErrorLocation,
} from "./preview-errors";
import { revealSlideIndex } from "./preview-reveal";

tmp.setGracefulCleanup();

const kLocalPreviewRegex =
  /(http:\/\/(?:localhost|127\.0\.0\.1)\:\d+\/?[^\s]*)/;

let previewManager: PreviewManager;

export function activatePreview(
  context: ExtensionContext,
  quartoContext: QuartoContext,
  engine: MarkdownEngine
): Command[] {
  // create preview manager
  if (quartoContext.available) {
    previewManager = new PreviewManager(context, quartoContext, engine);
    context.subscriptions.push(previewManager);
  }

  // render on save
  const onSave = async (docUri: Uri) => {
    const editor = findEditor(
      (editorDoc) => editorDoc.uri.fsPath === docUri.fsPath
    );
    if (editor) {
      if (
        canPreviewDoc(editor.document) &&
        (await renderOnSave(engine, editor)) &&
        (await previewManager.isPreviewRunning())
      ) {
        await previewDoc(editor, undefined, false, engine);
      }
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc: TextDocument) => {
      await onSave(doc.uri);
    })
  );
  // we use 1.60 as our minimum version (and type import) but
  // onDidSaveNotebookDocument was introduced in 1.67
  if ((vscode.workspace as any).onDidSaveNotebookDocument) {
    context.subscriptions.push(
      (vscode.workspace as any).onDidSaveNotebookDocument(
        async (notebook: NotebookDocument) => {
          await onSave(notebook.uri);
        }
      )
    );
  }

  // preview commands
  return previewCommands(quartoContext, engine);
}

export function canPreviewDoc(doc?: TextDocument) {
  return !!doc && !!(isQuartoDoc(doc) || isNotebook(doc));
}

export function isPreviewRunning() {
  return previewManager.isPreviewRunning();
}

export async function previewDoc(
  editor: TextEditor,
  format?: string | null,
  save?: boolean,
  engine?: MarkdownEngine,
  onShow?: () => void
) {
  // get the slide index if we can
  if (engine !== undefined) {
    // set the slide index from the source editor so we can
    // navigate to it in the preview frame
    if (!isNotebook(editor.document)) {
      previewManager.setSlideIndex(
        await revealSlideIndex(editor.selection.active, editor.document, engine)
      );
    }
  }
  //  set onShow if provided
  if (onShow !== undefined) {
    previewManager.setOnShow(onShow);
  }

  // activate the editor
  if (!isNotebook(editor.document)) {
    await window.showTextDocument(editor.document, editor.viewColumn, false);
  }

  // save (exit if we cancelled)
  if (save) {
    await commands.executeCommand("workbench.action.files.save");
    if (editor.document.isDirty) {
      return;
    }
  }

  // execute the preview
  const doc = window.activeTextEditor?.document;
  if (doc) {
    // error if we didn't save using a valid quarto extension
    if (!isNotebook(doc) && !validatateQuartoExtension(doc)) {
      window.showErrorMessage("Unsupported File Extension", {
        modal: true,
        detail:
          "This document cannot be rendered because it doesn't have a supported Quarto file extension. " +
          "Save the file with a .qmd extension then try rendering again.",
      });
      return;
    }

    // run the preview
    await previewManager.preview(doc.uri, doc, format);

    // focus the editor (sometimes the terminal steals focus)
    if (!isNotebook(doc)) {
      await window.showTextDocument(doc, editor.viewColumn, false);
    }
  }
}

export async function previewProject(target: Uri, format?: string) {
  await previewManager.preview(target, undefined, format);
}

class PreviewManager {
  constructor(
    context: ExtensionContext,
    private readonly quartoContext_: QuartoContext,
    private readonly engine_: MarkdownEngine
  ) {
    this.renderToken_ = uuid.v4();
    this.webviewManager_ = new QuartoPreviewWebviewManager(
      context,
      "quarto.previewView",
      "Quarto Preview",
      QuartoPreviewWebview
    );
    this.outputSink_ = new PreviewOutputSink(this.onPreviewOutput.bind(this));
    this.previewEnvManager_ = new PreviewEnvManager(
      this.outputSink_,
      this.renderToken_
    );
  }

  dispose() {
    this.webviewManager_.dispose();
    this.outputSink_.dispose();
  }

  public async preview(uri: Uri, doc?: TextDocument, format?: string | null) {
    // resolve format if we need to
    if (format === undefined) {
      format = this.previewFormats_.get(uri.fsPath) || null;
    } else {
      this.previewFormats_.set(uri.fsPath, format);
    }

    this.previewOutput_ = "";
    this.previewDoc_ = doc;
    const previewEnv = await this.previewEnvManager_.previewEnv(uri);
    if (doc && (await this.canReuseRunningPreview(doc, previewEnv))) {
      try {
        const response = await this.previewRenderRequest(doc, format);
        if (response.status === 200) {
          this.terminal_!.show(true);
        } else {
          await this.startPreview(previewEnv, uri, format, doc);
        }
      } catch (e) {
        await this.startPreview(previewEnv, uri, format, doc);
      }
    } else {
      await this.startPreview(previewEnv, uri, format, doc);
    }
  }

  public setSlideIndex(slideIndex: number) {
    this.webviewManager_.setSlideIndex(slideIndex);
  }

  public setOnShow(f: () => void) {
    this.webviewManager_.setOnShow(f);
  }

  public async isPreviewRunning() {
    // no terminal means no preview server
    if (!this.terminal_ || this.terminal_.exitStatus !== undefined) {
      return false;
    }

    // no recorded preview server uri
    if (!this.previewCommandUrl_) {
      return false;
    }

    // look for any response from the server (it will give a 404 w/o logging for favicon)
    const pingRequestUri = this.previewServerRequestUri("/favicon.ico");
    try {
      const response = await axios.get(pingRequestUri, {
        timeout: 1000,
        validateStatus: () => true,
      });
      return response.status === 200 || response.status === 404;
    } catch (e) {
      return false;
    }
  }

  private async canReuseRunningPreview(
    doc: TextDocument,
    previewEnv: PreviewEnv
  ) {
    return (
      !!this.previewUrl_ &&
      previewEnvsEqual(this.previewEnv_, previewEnv) &&
      this.previewType_ === this.previewTypeConfig() &&
      (this.previewType_ !== "internal" || this.webviewManager_.hasWebview()) &&
      !!this.terminal_ &&
      this.terminal_.exitStatus === undefined &&
      !(await isQuartoShinyDoc(this.engine_, doc))
    );
  }

  private previewRenderRequest(doc: TextDocument, format: string | null) {
    const requestUri = this.previewServerRequestUri("/" + this.renderToken_);

    const params: Record<string, unknown> = {
      path: doc.uri.fsPath,
    };
    if (format) {
      params.format = format;
    }
    return axios.get(requestUri, { params });
  }

  private async previewTerminateRequest() {
    const kTerminateToken = "4231F431-58D3-4320-9713-994558E4CC45";
    try {
      await axios.get(this.previewServerRequestUri("/" + kTerminateToken), {
        timeout: 1000,
      });
    } catch (error) {
      /*
      console.log("Error requesting preview server termination");
      console.log(error);
      */
    }
  }

  private previewServerRequestUri(path: string) {
    const previewUri = Uri.parse(this.previewCommandUrl_!);
    const requestUri = previewUri.scheme + "://" + previewUri.authority + path;
    return requestUri;
  }

  private async startPreview(
    previewEnv: PreviewEnv,
    target: Uri,
    format: string | null,
    doc?: TextDocument
  ) {
    // dispose any existing preview terminals
    const kPreviewWindowTitle = "Quarto Preview";
    const terminal = window.terminals.find((terminal) => {
      return terminal.name === kPreviewWindowTitle;
    });
    if (terminal) {
      await this.previewTerminateRequest();
      terminal.dispose();
    }

    // cleanup output
    this.outputSink_.reset();

    // reset preview state
    this.previewEnv_ = previewEnv;
    this.previewTarget_ = target;
    this.previewType_ = this.previewTypeConfig();
    this.previewUrl_ = undefined;
    this.previewDir_ = undefined;
    this.previewCommandUrl_ = undefined;
    this.previewOutputFile_ = undefined;

    // determine preview dir (if any)
    const isFile = fs.statSync(target.fsPath).isFile();
    this.previewDir_ = isFile ? previewDirForDocument(target) : undefined;

    // calculate cwd
    const cwd = this.previewDir_ || this.targetDir();

    // create and show the terminal
    const options: TerminalOptions = {
      name: kPreviewWindowTitle,
      cwd,
      env: this.previewEnv_ as unknown as {
        [key: string]: string | null | undefined;
      },
    };

    // add crossref index path to env (will be ignored if we are in a project)
    if (isFile) {
      options.env!["QUARTO_CROSSREF_INDEX_PATH"] = fileCrossrefIndexStorage(
        target.fsPath
      );
    }

    // is this is a shiny doc?
    const isShiny = await isQuartoShinyDoc(this.engine_, doc);

    // clear if a shiny doc
    if (isShiny && this.webviewManager_) {
      this.webviewManager_.clear();
    }

    this.terminal_ = window.createTerminal(options);
    const quarto = "quarto"; // binPath prepended to PATH so we don't need the full form
    const cmd: string[] = [
      this.quartoContext_.useCmd ? winShEscape(quarto) : shQuote(quarto),
      isShiny ? "serve" : "preview",
      shQuote(target.fsPath),
    ];

    // extra args for normal docs
    if (!isShiny) {
      if (!doc) {
        // project render
        cmd.push("--render", format || "all");
      } else if (format) {
        // doc render
        cmd.push("--to", format);
      }

      cmd.push("--no-browser");
      cmd.push("--no-watch-inputs");
    }

    const cmdText = this.quartoContext_.useCmd
      ? `cmd /C"${cmd.join(" ")}"`
      : cmd.join(" ");
    this.terminal_.show(true);
    // delay if required (e.g. to allow conda to initialized)
    // wait for up to 5 seconds (note that we can do this without
    // risk of undue delay b/c the state.isInteractedWith bit will
    // flip as soon as the environment has been activated)
    if (requiresTerminalDelay(this.previewEnv_)) {
      const kMaxSleep = 5000;
      const kInterval = 100;
      let totalSleep = 0;
      while (!this.terminal_.state.isInteractedWith && totalSleep < kMaxSleep) {
        await sleep(kInterval);
        totalSleep += kInterval;
      }
    }

    this.terminal_.sendText(cmdText, true);
  }

  private async onPreviewOutput(output: string) {
    this.detectErrorNavigation(output);
    const kOutputCreatedPattern = /Output created\: (.*?)\n/;
    this.previewOutput_ += output;
    if (!this.previewUrl_) {
      // detect new preview and show in browser
      const match = this.previewOutput_.match(kLocalPreviewRegex);
      if (match) {
        // capture output file
        const fileMatch = this.previewOutput_.match(kOutputCreatedPattern);
        if (fileMatch) {
          this.previewOutputFile_ = this.outputFileUri(fileMatch[1]);
        }

        // capture preview command url and preview url
        this.previewCommandUrl_ = match[1];
        const browseMatch = this.previewOutput_.match(
          /(Browse at|Listening on) (https?:\/\/[^\s]*)/
        );
        if (browseMatch) {
          // shiny document
          if (await isQuartoShinyDoc(this.engine_, this.previewDoc_)) {
            this.previewUrl_ = vsCodeWebUrl(browseMatch[2]);
          } else {
            this.previewUrl_ = browseMatch[2];
          }
        } else {
          this.previewUrl_ = this.previewCommandUrl_;
        }

        // if there was a 'preview service running' message then that
        // also establishes an alternate control channel
        const previewServiceMatch = this.previewOutput_.match(
          /Preview service running \((\d+)\)/
        );
        if (previewServiceMatch) {
          this.previewCommandUrl_ = `http://127.0.0.1:${previewServiceMatch[1]}`;
        }

        if (this.previewType_ === "internal") {
          this.showPreview();
        } else if (this.previewType_ === "external") {
          try {
            const url = Uri.parse(this.previewUrl_);
            env.openExternal(url);
          } catch {
            // Noop
          }
        }
      }
    } else {
      // detect update to existing preview and activate browser
      if (this.previewOutput_.match(kOutputCreatedPattern)) {
        if (this.previewType_ === "internal" && this.previewRevealConfig()) {
          this.updatePreview();
        }
      }
    }
  }

  private async detectErrorNavigation(output: string) {
    // bail if this is a notebook or we don't have a previewDoc
    if (!this.previewDoc_ || isNotebook(this.previewDoc_)) {
      return;
    }

    // normalize
    output = normalizeNewlines(output);

    // run all of our tests
    const previewFile = this.previewDoc_.uri.fsPath;
    const previewDir = this.previewDir_ || this.targetDir();
    const errorLoc =
      yamlErrorLocation(output, previewFile, previewDir) ||
      jupyterErrorLocation(output, previewFile, previewDir) ||
      knitrErrorLocation(output, previewFile, previewDir) ||
      luaErrorLocation(output, previewFile, previewDir);
    if (errorLoc && fs.existsSync(errorLoc.file)) {
      // find existing visible instance
      const fileUri = Uri.file(errorLoc.file);
      const editor = findEditor((doc) => doc.uri.fsPath === fileUri.fsPath);
      if (editor) {
        // if the current selection is outside of the error region then
        // navigate to the top of the error region
        const errPos = new Position(errorLoc.lineBegin - 1, 0);
        const errEndPos = new Position(errorLoc.lineEnd - 1, 0);
        if (
          editor.selection.active.isBefore(errPos) ||
          editor.selection.active.isAfter(errEndPos)
        ) {
          editor.selection = new Selection(errPos, errPos);
          editor.revealRange(
            new Range(errPos, errPos),
            TextEditorRevealType.InCenterIfOutsideViewport
          );
        }
        preserveEditorFocus(editor);
      }
    }
  }

  private showPreview() {
    if (
      (!this.previewOutputFile_ || // no output file means project render/preview
        this.isBrowserPreviewable(this.previewOutputFile_)) &&
      !isHugoMarkdown(this.previewOutputFile_) // hugo preview done via 'hugo serve'
    ) {
      this.webviewManager_.showWebview(this.previewUrl_!, {
        preserveFocus: true,
        viewColumn: ViewColumn.Beside,
      });
    } else {
      this.showOuputFile();
    }
  }

  private updatePreview() {
    if (this.isBrowserPreviewable(this.previewOutputFile_)) {
      this.webviewManager_.revealWebview();
    } else {
      this.showOuputFile();
    }
  }

  private targetDir() {
    const targetPath = this.previewTarget_!.fsPath;
    if (fs.statSync(targetPath).isDirectory()) {
      return targetPath;
    } else {
      return path.dirname(targetPath);
    }
  }

  private outputFileUri(file: string) {
    if (path.isAbsolute(file)) {
      return Uri.file(file);
    } else {
      return Uri.file(path.join(this.targetDir()!, file));
    }
  }

  private isBrowserPreviewable(uri?: Uri) {
    return (
      isHtmlContent(uri?.toString()) ||
      isPdfContent(uri?.toString()) ||
      isTextContent(uri?.toString())
    );
  }

  private previewTypeConfig(): "internal" | "external" | "none" {
    return this.quartoConfig().get("render.previewType", "internal");
  }

  private previewRevealConfig(): boolean {
    return this.quartoConfig().get("render.previewReveal", true);
  }

  private quartoConfig() {
    return vscode.workspace.getConfiguration("quarto");
  }

  private async showOuputFile() {
    if (this.previewOutputFile_) {
      const outputFile = this.previewOutputFile_.fsPath;
      const viewFile: MessageItem = { title: "View Preview" };
      const result = await window.showInformationMessage<MessageItem>(
        "Render complete for " + path.basename(outputFile),
        viewFile
      );
      if (result === viewFile) {
        // open non localhost urls externally
        if (this.previewUrl_ && !this.previewUrl_.match(kLocalPreviewRegex)) {
          vscode.env.openExternal(Uri.parse(this.previewUrl_!));
        } else {
          const outputTempDir = tmp.dirSync();
          const outputTemp = path.join(
            outputTempDir.name,
            path.basename(outputFile)
          );
          fs.copyFileSync(outputFile, outputTemp);
          fs.chmodSync(outputTemp, fs.constants.S_IRUSR);
          vscode.env.openExternal(Uri.file(outputTemp));
        }
      }
    }
  }

  private previewOutput_ = "";
  private previewDoc_: TextDocument | undefined;
  private previewEnv_: PreviewEnv | undefined;
  private previewTarget_: Uri | undefined;
  private previewUrl_: string | undefined;
  private previewDir_: string | undefined;
  private previewCommandUrl_: string | undefined;
  private previewOutputFile_: Uri | undefined;
  private previewType_: "internal" | "external" | "none" | undefined;

  private terminal_: Terminal | undefined;

  private readonly renderToken_: string;
  private readonly previewEnvManager_: PreviewEnvManager;
  private readonly webviewManager_: QuartoPreviewWebviewManager;
  private readonly outputSink_: PreviewOutputSink;
  private readonly previewFormats_ = new Map<string, string | null>();
}
