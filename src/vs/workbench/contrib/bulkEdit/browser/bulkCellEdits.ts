/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICellEdit } from 'sql/workbench/services/notebook/browser/models/modelInterfaces';
import { INotebookService } from 'sql/workbench/services/notebook/browser/notebookService';
import { groupBy } from 'vs/base/common/arrays';
import { CancellationToken } from 'vs/base/common/cancellation';
import { compare } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { ResourceEdit } from 'vs/editor/browser/services/bulkEditService';
import { WorkspaceEditMetadata } from 'vs/editor/common/modes';
import { IProgress } from 'vs/platform/progress/common/progress';
import { UndoRedoGroup, UndoRedoSource } from 'vs/platform/undoRedo/common/undoRedo';
import { CellEditType, ICellEditOperation } from 'vs/workbench/contrib/notebook/common/notebookCommon';

export class ResourceNotebookCellEdit extends ResourceEdit {

	constructor(
		readonly resource: URI,
		readonly cellEdit: ICellEditOperation,
		readonly versionId?: number,
		metadata?: WorkspaceEditMetadata
	) {
		super(metadata);
	}
}

export class BulkCellEdits {

	// {{SQL CARBON EDIT}} Remove private modifiers to fix value-not-read build errors
	constructor(
		_undoRedoGroup: UndoRedoGroup,
		undoRedoSource: UndoRedoSource | undefined,
		private _progress: IProgress<void>,
		private _token: CancellationToken,
		private _edits: ResourceNotebookCellEdit[],
		@INotebookService private _notebookService: INotebookService
	) { }

	// {{SQL CARBON EDIT}} Use our own notebooks
	async apply(): Promise<void> {
		const editsByNotebook = groupBy(this._edits, (a, b) => compare(a.resource.toString(), b.resource.toString()));
		for (let group of editsByNotebook) {
			if (this._token.isCancellationRequested) {
				break;
			}
			const [first] = group;
			let editor = await this._notebookService.findNotebookEditor(first.resource);
			if (editor) {
				const edits = group.map(entry => entry.cellEdit);
				await editor.applyCellEdits(convertToCellEdit(edits));
			}

			this._progress.report(undefined);
		}
	}
}

function convertToCellEdit(edits: ICellEditOperation[]): ICellEdit[] {
	let convertedEdits = [];
	for (let edit of edits) {
		switch (edit.editType) {
			case CellEditType.Replace:
			case CellEditType.Output:
			case CellEditType.Metadata:
			case CellEditType.CellLanguage:
			case CellEditType.DocumentMetadata:
			case CellEditType.Move:
			case CellEditType.OutputItems:
			case CellEditType.PartialMetadata:
			case CellEditType.PartialInternalMetadata:
				continue;
		}
	}
	return convertedEdits;
}
