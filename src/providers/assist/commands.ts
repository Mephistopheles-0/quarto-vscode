/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RStudio, PBC. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands } from "vscode";
import { Command } from "../../core/command";

export class PreviewMathCommand implements Command {
  private static readonly id = "quarto.previewMath";
  public readonly id = PreviewMathCommand.id;
  execute(_line: number): void {
    commands.executeCommand("quarto-assist.focus");
  }
}
