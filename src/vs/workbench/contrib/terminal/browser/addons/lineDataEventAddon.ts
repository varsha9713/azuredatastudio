/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { OperatingSystem } from 'vs/base/common/platform';
import type { Terminal as XTermTerminal, IBuffer, ITerminalAddon } from 'xterm';

/**
 * Provides extensions to the xterm object in a modular, testable way.
 */
export class LineDataEventAddon extends Disposable implements ITerminalAddon {

	private _xterm?: XTermTerminal;
	private _isOsSet = false;

	private readonly _onLineData = this._register(new Emitter<string>());
	readonly onLineData = this._onLineData.event;

	activate(xterm: XTermTerminal) {
		this._xterm = xterm;
		// Fire onLineData when a line feed occurs, taking into account wrapped lines
		xterm.onLineFeed(() => {
			const buffer = xterm.buffer;
			const newLine = buffer.active.getLine(buffer.active.baseY + buffer.active.cursorY);
			if (newLine && !newLine.isWrapped) {
				this._sendLineData(buffer.active, buffer.active.baseY + buffer.active.cursorY - 1);
			}
		});

		// Fire onLineData when disposing object to flush last line
		this._register(toDisposable(() => {
			const buffer = xterm.buffer;
			this._sendLineData(buffer.active, buffer.active.baseY + buffer.active.cursorY);
		}));
	}

	setOperatingSystem(os: OperatingSystem) {
		if (this._isOsSet || !this._xterm) {
			return;
		}
		this._isOsSet = true;

		// Force line data to be sent when the cursor is moved, the main purpose for
		// this is because ConPTY will often not do a line feed but instead move the
		// cursor, in which case we still want to send the current line's data to tasks.
		if (os === OperatingSystem.Windows) {
			const xterm = this._xterm;
			this._register(xterm.parser.registerCsiHandler({ final: 'H' }, () => {
				const buffer = xterm.buffer;
				this._sendLineData(buffer.active, buffer.active.baseY + buffer.active.cursorY);
				return false;
			}));
		}
	}

	private _sendLineData(buffer: IBuffer, lineIndex: number): void {
		let line = buffer.getLine(lineIndex);
		if (!line) {
			return;
		}
		let lineData = line.translateToString(true);
		while (lineIndex > 0 && line.isWrapped) {
			line = buffer.getLine(--lineIndex);
			if (!line) {
				break;
			}
			lineData = line.translateToString(false) + lineData;
		}
		this._onLineData.fire(lineData);
	}
}
