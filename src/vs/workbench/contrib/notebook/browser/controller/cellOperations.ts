/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IBulkEditService, ResourceEdit, ResourceTextEdit } from 'vs/editor/browser/services/bulkEditService';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { EndOfLinePreference, IReadonlyTextBuffer } from 'vs/editor/common/model';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ResourceNotebookCellEdit } from 'vs/workbench/contrib/bulkEdit/browser/bulkCellEdits';
import { INotebookActionContext, INotebookCellActionContext } from 'vs/workbench/contrib/notebook/browser/controller/coreActions';
import { CellEditState, CellFocusMode, expandCellRangesWithHiddenCells, IActiveNotebookEditor, ICellViewModel } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellViewModel, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { cloneNotebookCellTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel';
import { CellEditType, CellKind, ICellEditOperation, ICellReplaceEdit, IOutputDto, ISelectionState, NotebookCellMetadata, SelectionStateType } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { cellRangeContains, cellRangesToIndexes, ICellRange } from 'vs/workbench/contrib/notebook/common/notebookRange';

export async function changeCellToKind(kind: CellKind, context: INotebookActionContext, language?: string, mime?: string): Promise<void> {
	const { notebookEditor } = context;
	if (!notebookEditor.hasModel()) {
		return;
	}

	if (notebookEditor.isReadOnly) {
		return;
	}

	if (context.ui && context.cell) {
		// action from UI
		const { cell } = context;

		if (cell.cellKind === kind) {
			return;
		}

		const text = cell.getText();
		const idx = notebookEditor.getCellIndex(cell);

		if (language === undefined) {
			const availableLanguages = notebookEditor.activeKernel?.supportedLanguages ?? [];
			language = availableLanguages[0] ?? 'plaintext';
		}

		notebookEditor.textModel.applyEdits([
			{
				editType: CellEditType.Replace,
				index: idx,
				count: 1,
				cells: [{
					cellKind: kind,
					source: text,
					language: language!,
					mime: mime ?? cell.mime,
					outputs: cell.model.outputs,
					metadata: cell.metadata,
				}]
			}
		], true, {
			kind: SelectionStateType.Index,
			focus: notebookEditor.getFocus(),
			selections: notebookEditor.getSelections()
		}, () => {
			return {
				kind: SelectionStateType.Index,
				focus: notebookEditor.getFocus(),
				selections: notebookEditor.getSelections()
			};
		}, undefined, true);
		const newCell = notebookEditor.cellAt(idx);
		notebookEditor.focusNotebookCell(newCell, cell.getEditState() === CellEditState.Editing ? 'editor' : 'container');
	} else if (context.selectedCells) {
		const selectedCells = context.selectedCells;
		const rawEdits: ICellEditOperation[] = [];

		selectedCells.forEach(cell => {
			if (cell.cellKind === kind) {
				return;
			}
			const text = cell.getText();
			const idx = notebookEditor.getCellIndex(cell);

			if (language === undefined) {
				const availableLanguages = notebookEditor.activeKernel?.supportedLanguages ?? [];
				language = availableLanguages[0] ?? 'plaintext';
			}

			rawEdits.push(
				{
					editType: CellEditType.Replace,
					index: idx,
					count: 1,
					cells: [{
						cellKind: kind,
						source: text,
						language: language!,
						mime: mime ?? cell.mime,
						outputs: cell.model.outputs,
						metadata: cell.metadata,
					}]
				}
			);
		});

		notebookEditor.textModel.applyEdits(rawEdits, true, {
			kind: SelectionStateType.Index,
			focus: notebookEditor.getFocus(),
			selections: notebookEditor.getSelections()
		}, () => {
			return {
				kind: SelectionStateType.Index,
				focus: notebookEditor.getFocus(),
				selections: notebookEditor.getSelections()
			};
		}, undefined, true);
	}
}

export function runDeleteAction(editor: IActiveNotebookEditor, cell: ICellViewModel) {
	const textModel = editor.textModel;
	const selections = editor.getSelections();
	const targetCellIndex = editor.getCellIndex(cell);
	const containingSelection = selections.find(selection => selection.start <= targetCellIndex && targetCellIndex < selection.end);

	if (containingSelection) {
		const edits: ICellReplaceEdit[] = selections.reverse().map(selection => ({
			editType: CellEditType.Replace, index: selection.start, count: selection.end - selection.start, cells: []
		}));

		const nextCellAfterContainingSelection = containingSelection.end >= editor.getLength() ? undefined : editor.cellAt(containingSelection.end);

		textModel.applyEdits(edits, true, { kind: SelectionStateType.Index, focus: editor.getFocus(), selections: editor.getSelections() }, () => {
			if (nextCellAfterContainingSelection) {
				const cellIndex = textModel.cells.findIndex(cell => cell.handle === nextCellAfterContainingSelection.handle);
				return { kind: SelectionStateType.Index, focus: { start: cellIndex, end: cellIndex + 1 }, selections: [{ start: cellIndex, end: cellIndex + 1 }] };
			} else {
				if (textModel.length) {
					const lastCellIndex = textModel.length - 1;
					return { kind: SelectionStateType.Index, focus: { start: lastCellIndex, end: lastCellIndex + 1 }, selections: [{ start: lastCellIndex, end: lastCellIndex + 1 }] };

				} else {
					return { kind: SelectionStateType.Index, focus: { start: 0, end: 0 }, selections: [{ start: 0, end: 0 }] };
				}
			}
		}, undefined);
	} else {
		const focus = editor.getFocus();
		const edits: ICellReplaceEdit[] = [{
			editType: CellEditType.Replace, index: targetCellIndex, count: 1, cells: []
		}];

		let finalSelections: ICellRange[] = [];
		for (let i = 0; i < selections.length; i++) {
			const selection = selections[i];

			if (selection.end <= targetCellIndex) {
				finalSelections.push(selection);
			} else if (selection.start > targetCellIndex) {
				finalSelections.push({ start: selection.start - 1, end: selection.end - 1 });
			} else {
				finalSelections.push({ start: targetCellIndex, end: targetCellIndex + 1 });
			}
		}

		if (editor.cellAt(focus.start) === cell) {
			// focus is the target, focus is also not part of any selection
			const newFocus = focus.end === textModel.length ? { start: focus.start - 1, end: focus.end - 1 } : focus;

			textModel.applyEdits(edits, true, { kind: SelectionStateType.Index, focus: editor.getFocus(), selections: editor.getSelections() }, () => ({
				kind: SelectionStateType.Index, focus: newFocus, selections: finalSelections
			}), undefined);
		} else {
			// users decide to delete a cell out of current focus/selection
			const newFocus = focus.start > targetCellIndex ? { start: focus.start - 1, end: focus.end - 1 } : focus;

			textModel.applyEdits(edits, true, { kind: SelectionStateType.Index, focus: editor.getFocus(), selections: editor.getSelections() }, () => ({
				kind: SelectionStateType.Index, focus: newFocus, selections: finalSelections
			}), undefined);
		}
	}
}

export async function moveCellRange(context: INotebookCellActionContext, direction: 'up' | 'down'): Promise<void> {
	if (!context.notebookEditor.hasModel()) {
		return;
	}
	const editor = context.notebookEditor;
	const textModel = editor.textModel;

	if (editor.isReadOnly) {
		return;
	}

	const selections = editor.getSelections();
	const modelRanges = expandCellRangesWithHiddenCells(editor, selections);
	const range = modelRanges[0];
	if (!range || range.start === range.end) {
		return;
	}

	if (direction === 'up') {
		if (range.start === 0) {
			return;
		}

		const indexAbove = range.start - 1;
		const finalSelection = { start: range.start - 1, end: range.end - 1 };
		const focus = context.notebookEditor.getFocus();
		const newFocus = cellRangeContains(range, focus) ? { start: focus.start - 1, end: focus.end - 1 } : { start: range.start - 1, end: range.start };
		textModel.applyEdits([
			{
				editType: CellEditType.Move,
				index: indexAbove,
				length: 1,
				newIdx: range.end - 1
			}],
			true,
			{
				kind: SelectionStateType.Index,
				focus: editor.getFocus(),
				selections: editor.getSelections()
			},
			() => ({ kind: SelectionStateType.Index, focus: newFocus, selections: [finalSelection] }),
			undefined
		);
		const focusRange = editor.getSelections()[0] ?? editor.getFocus();
		editor.revealCellRangeInView(focusRange);
	} else {
		if (range.end >= textModel.length) {
			return;
		}

		const indexBelow = range.end;
		const finalSelection = { start: range.start + 1, end: range.end + 1 };
		const focus = editor.getFocus();
		const newFocus = cellRangeContains(range, focus) ? { start: focus.start + 1, end: focus.end + 1 } : { start: range.start + 1, end: range.start + 2 };

		textModel.applyEdits([
			{
				editType: CellEditType.Move,
				index: indexBelow,
				length: 1,
				newIdx: range.start
			}],
			true,
			{
				kind: SelectionStateType.Index,
				focus: editor.getFocus(),
				selections: editor.getSelections()
			},
			() => ({ kind: SelectionStateType.Index, focus: newFocus, selections: [finalSelection] }),
			undefined
		);

		const focusRange = editor.getSelections()[0] ?? editor.getFocus();
		editor.revealCellRangeInView(focusRange);
	}
}

export async function copyCellRange(context: INotebookCellActionContext, direction: 'up' | 'down'): Promise<void> {
	const editor = context.notebookEditor;
	if (!editor.hasModel()) {
		return;
	}

	const textModel = editor.textModel;

	if (editor.isReadOnly) {
		return;
	}

	let range: ICellRange | undefined = undefined;

	if (context.ui) {
		let targetCell = context.cell;
		const targetCellIndex = editor.getCellIndex(targetCell);
		range = { start: targetCellIndex, end: targetCellIndex + 1 };
	} else {
		const selections = editor.getSelections();
		const modelRanges = expandCellRangesWithHiddenCells(editor, selections);
		range = modelRanges[0];
	}

	if (!range || range.start === range.end) {
		return;
	}

	if (direction === 'up') {
		// insert up, without changing focus and selections
		const focus = editor.getFocus();
		const selections = editor.getSelections();
		textModel.applyEdits([
			{
				editType: CellEditType.Replace,
				index: range.end,
				count: 0,
				cells: cellRangesToIndexes([range]).map(index => cloneNotebookCellTextModel(editor.cellAt(index)!.model))
			}],
			true,
			{
				kind: SelectionStateType.Index,
				focus: focus,
				selections: selections
			},
			() => ({ kind: SelectionStateType.Index, focus: focus, selections: selections }),
			undefined
		);
	} else {
		// insert down, move selections
		const focus = editor.getFocus();
		const selections = editor.getSelections();
		const newCells = cellRangesToIndexes([range]).map(index => cloneNotebookCellTextModel(editor.cellAt(index)!.model));
		const countDelta = newCells.length;
		const newFocus = context.ui ? focus : { start: focus.start + countDelta, end: focus.end + countDelta };
		const newSelections = context.ui ? selections : [{ start: range.start + countDelta, end: range.end + countDelta }];
		textModel.applyEdits([
			{
				editType: CellEditType.Replace,
				index: range.end,
				count: 0,
				cells: cellRangesToIndexes([range]).map(index => cloneNotebookCellTextModel(editor.cellAt(index)!.model))
			}],
			true,
			{
				kind: SelectionStateType.Index,
				focus: focus,
				selections: selections
			},
			() => ({ kind: SelectionStateType.Index, focus: newFocus, selections: newSelections }),
			undefined
		);

		const focusRange = editor.getSelections()[0] ?? editor.getFocus();
		editor.revealCellRangeInView(focusRange);
	}
}

export async function joinNotebookCells(editor: IActiveNotebookEditor, range: ICellRange, direction: 'above' | 'below', constraint?: CellKind): Promise<{ edits: ResourceEdit[], cell: ICellViewModel, endFocus: ICellRange, endSelections: ICellRange[]; } | null> {
	if (editor.isReadOnly) {
		return null;
	}

	const textModel = editor.textModel;
	const cells = editor.getCellsInRange(range);

	if (!cells.length) {
		return null;
	}

	if (range.start === 0 && direction === 'above') {
		return null;
	}

	if (range.end === textModel.length && direction === 'below') {
		return null;
	}

	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];

		if (constraint && cell.cellKind !== constraint) {
			return null;
		}
	}

	if (direction === 'above') {
		const above = editor.cellAt(range.start - 1) as CellViewModel;
		if (constraint && above.cellKind !== constraint) {
			return null;
		}

		const insertContent = cells.map(cell => (cell.textBuffer.getEOL() ?? '') + cell.getText()).join('');
		const aboveCellLineCount = above.textBuffer.getLineCount();
		const aboveCellLastLineEndColumn = above.textBuffer.getLineLength(aboveCellLineCount);

		return {
			edits: [
				new ResourceTextEdit(above.uri, { range: new Range(aboveCellLineCount, aboveCellLastLineEndColumn + 1, aboveCellLineCount, aboveCellLastLineEndColumn + 1), text: insertContent }),
				new ResourceNotebookCellEdit(textModel.uri,
					{
						editType: CellEditType.Replace,
						index: range.start,
						count: range.end - range.start,
						cells: []
					}
				)
			],
			cell: above,
			endFocus: { start: range.start - 1, end: range.start },
			endSelections: [{ start: range.start - 1, end: range.start }]
		};
	} else {
		const below = editor.cellAt(range.end) as CellViewModel;
		if (constraint && below.cellKind !== constraint) {
			return null;
		}

		const cell = cells[0];
		const restCells = [...cells.slice(1), below];
		const insertContent = restCells.map(cl => (cl.textBuffer.getEOL() ?? '') + cl.getText()).join('');

		const cellLineCount = cell.textBuffer.getLineCount();
		const cellLastLineEndColumn = cell.textBuffer.getLineLength(cellLineCount);

		return {
			edits: [
				new ResourceTextEdit(cell.uri, { range: new Range(cellLineCount, cellLastLineEndColumn + 1, cellLineCount, cellLastLineEndColumn + 1), text: insertContent }),
				new ResourceNotebookCellEdit(textModel.uri,
					{
						editType: CellEditType.Replace,
						index: range.start + 1,
						count: range.end - range.start,
						cells: []
					}
				)
			],
			cell,
			endFocus: { start: range.start, end: range.start + 1 },
			endSelections: [{ start: range.start, end: range.start + 1 }]
		};
	}
}

export async function joinCellsWithSurrounds(bulkEditService: IBulkEditService, context: INotebookCellActionContext, direction: 'above' | 'below'): Promise<void> {
	const editor = context.notebookEditor;
	const textModel = editor.textModel;
	const viewModel = editor._getViewModel();
	let ret: {
		edits: ResourceEdit[];
		cell: ICellViewModel;
		endFocus: ICellRange;
		endSelections: ICellRange[];
	} | null = null;

	if (context.ui) {
		const focusMode = context.cell.focusMode;
		const cellIndex = editor.getCellIndex(context.cell);
		ret = await joinNotebookCells(editor, { start: cellIndex, end: cellIndex + 1 }, direction);
		if (!ret) {
			return;
		}

		await bulkEditService.apply(
			ret?.edits,
			{ quotableLabel: 'Join Notebook Cells' }
		);
		viewModel.updateSelectionsState({ kind: SelectionStateType.Index, focus: ret.endFocus, selections: ret.endSelections });
		ret.cell.updateEditState(CellEditState.Editing, 'joinCellsWithSurrounds');
		editor.revealCellRangeInView(editor.getFocus());
		if (focusMode === CellFocusMode.Editor) {
			ret.cell.focusMode = CellFocusMode.Editor;
		}
	} else {
		const selections = editor.getSelections();
		if (!selections.length) {
			return;
		}

		const focus = editor.getFocus();
		const focusMode = editor.cellAt(focus.start)?.focusMode;

		let edits: ResourceEdit[] = [];
		let cell: ICellViewModel | null = null;
		let cells: ICellViewModel[] = [];

		for (let i = selections.length - 1; i >= 0; i--) {
			const selection = selections[i];
			const containFocus = cellRangeContains(selection, focus);

			if (
				selection.end >= textModel.length && direction === 'below'
				|| selection.start === 0 && direction === 'above'
			) {
				if (containFocus) {
					cell = editor.cellAt(focus.start)!;
				}

				cells.push(...editor.getCellsInRange(selection));
				continue;
			}

			const singleRet = await joinNotebookCells(editor, selection, direction);

			if (!singleRet) {
				return;
			}

			edits.push(...singleRet.edits);
			cells.push(singleRet.cell);

			if (containFocus) {
				cell = singleRet.cell;
			}
		}

		if (!edits.length) {
			return;
		}

		if (!cell || !cells.length) {
			return;
		}

		await bulkEditService.apply(
			edits,
			{ quotableLabel: 'Join Notebook Cells' }
		);

		cells.forEach(cell => {
			cell.updateEditState(CellEditState.Editing, 'joinCellsWithSurrounds');
		});

		viewModel.updateSelectionsState({ kind: SelectionStateType.Handle, primary: cell.handle, selections: cells.map(cell => cell.handle) });
		editor.revealCellRangeInView(editor.getFocus());
		const newFocusedCell = editor.cellAt(editor.getFocus().start);
		if (focusMode === CellFocusMode.Editor && newFocusedCell) {
			newFocusedCell.focusMode = CellFocusMode.Editor;
		}
	}
}

function _splitPointsToBoundaries(splitPoints: IPosition[], textBuffer: IReadonlyTextBuffer): IPosition[] | null {
	const boundaries: IPosition[] = [];
	const lineCnt = textBuffer.getLineCount();
	const getLineLen = (lineNumber: number) => {
		return textBuffer.getLineLength(lineNumber);
	};

	// split points need to be sorted
	splitPoints = splitPoints.sort((l, r) => {
		const lineDiff = l.lineNumber - r.lineNumber;
		const columnDiff = l.column - r.column;
		return lineDiff !== 0 ? lineDiff : columnDiff;
	});

	for (let sp of splitPoints) {
		if (getLineLen(sp.lineNumber) + 1 === sp.column && sp.column !== 1 /** empty line */ && sp.lineNumber < lineCnt) {
			sp = new Position(sp.lineNumber + 1, 1);
		}
		_pushIfAbsent(boundaries, sp);
	}

	if (boundaries.length === 0) {
		return null;
	}

	// boundaries already sorted and not empty
	const modelStart = new Position(1, 1);
	const modelEnd = new Position(lineCnt, getLineLen(lineCnt) + 1);
	return [modelStart, ...boundaries, modelEnd];
}

function _pushIfAbsent(positions: IPosition[], p: IPosition) {
	const last = positions.length > 0 ? positions[positions.length - 1] : undefined;
	if (!last || last.lineNumber !== p.lineNumber || last.column !== p.column) {
		positions.push(p);
	}
}

export function computeCellLinesContents(cell: ICellViewModel, splitPoints: IPosition[]): string[] | null {
	const rangeBoundaries = _splitPointsToBoundaries(splitPoints, cell.textBuffer);
	if (!rangeBoundaries) {
		return null;
	}
	const newLineModels: string[] = [];
	for (let i = 1; i < rangeBoundaries.length; i++) {
		const start = rangeBoundaries[i - 1];
		const end = rangeBoundaries[i];

		newLineModels.push(cell.textBuffer.getValueInRange(new Range(start.lineNumber, start.column, end.lineNumber, end.column), EndOfLinePreference.TextDefined));
	}

	return newLineModels;
}

export function insertCell(
	modeService: IModeService,
	editor: IActiveNotebookEditor,
	index: number,
	type: CellKind,
	direction: 'above' | 'below' = 'above',
	initialText: string = '',
	ui: boolean = false
) {
	const viewModel = editor._getViewModel();
	const activeKernel = editor.activeKernel;
	if (viewModel.options.isReadOnly) {
		return null;
	}

	const cell = editor.cellAt(index);
	const nextIndex = ui ? viewModel.getNextVisibleCellIndex(index) : index + 1;
	let language;
	if (type === CellKind.Code) {
		const supportedLanguages = activeKernel?.supportedLanguages ?? modeService.getRegisteredModes();
		const defaultLanguage = supportedLanguages[0] || 'plaintext';
		if (cell?.cellKind === CellKind.Code) {
			language = cell.language;
		} else if (cell?.cellKind === CellKind.Markup) {
			const nearestCodeCellIndex = viewModel.nearestCodeCellIndex(index);
			if (nearestCodeCellIndex > -1) {
				language = viewModel.cellAt(nearestCodeCellIndex)!.language;
			} else {
				language = defaultLanguage;
			}
		} else {
			if (cell === undefined && direction === 'above') {
				// insert cell at the very top
				language = viewModel.viewCells.find(cell => cell.cellKind === CellKind.Code)?.language || defaultLanguage;
			} else {
				language = defaultLanguage;
			}
		}

		if (!supportedLanguages.includes(language)) {
			// the language no longer exists
			language = defaultLanguage;
		}
	} else {
		language = 'markdown';
	}

	const insertIndex = cell ?
		(direction === 'above' ? index : nextIndex) :
		index;
	return insertCellAtIndex(viewModel, insertIndex, initialText, language, type, undefined, [], true);
}

export function insertCellAtIndex(viewModel: NotebookViewModel, index: number, source: string, language: string, type: CellKind, metadata: NotebookCellMetadata | undefined, outputs: IOutputDto[], synchronous: boolean, pushUndoStop: boolean = true): CellViewModel {
	const endSelections: ISelectionState = { kind: SelectionStateType.Index, focus: { start: index, end: index + 1 }, selections: [{ start: index, end: index + 1 }] };
	viewModel.notebookDocument.applyEdits([
		{
			editType: CellEditType.Replace,
			index,
			count: 0,
			cells: [
				{
					cellKind: type,
					language: language,
					mime: undefined,
					outputs: outputs,
					metadata: metadata,
					source: source
				}
			]
		}
	], synchronous, { kind: SelectionStateType.Index, focus: viewModel.getFocus(), selections: viewModel.getSelections() }, () => endSelections, undefined, pushUndoStop);
	return viewModel.cellAt(index)!;
}


/**
 *
 * @param index
 * @param length
 * @param newIdx in an index scheme for the state of the tree after the current cell has been "removed"
 * @param synchronous
 * @param pushedToUndoStack
 */
export function moveCellToIdx(editor: IActiveNotebookEditor, index: number, length: number, newIdx: number, synchronous: boolean, pushedToUndoStack: boolean = true): boolean {
	const viewCell = editor.cellAt(index) as CellViewModel | undefined;
	if (!viewCell) {
		return false;
	}

	editor.textModel.applyEdits([
		{
			editType: CellEditType.Move,
			index,
			length,
			newIdx
		}
	], synchronous, { kind: SelectionStateType.Index, focus: editor.getFocus(), selections: editor.getSelections() }, () => ({ kind: SelectionStateType.Index, focus: { start: newIdx, end: newIdx + 1 }, selections: [{ start: newIdx, end: newIdx + 1 }] }), undefined);
	return true;
}
