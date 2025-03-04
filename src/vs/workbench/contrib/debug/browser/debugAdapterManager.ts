/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { IJSONSchema, IJSONSchemaMap } from 'vs/base/common/jsonSchema';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import Severity from 'vs/base/common/severity';
import * as strings from 'vs/base/common/strings';
import { isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { IEditorModel } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { IModeService } from 'vs/editor/common/services/modeService';
import * as nls from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Extensions as JSONExtensions, IJSONContributionRegistry } from 'vs/platform/jsonschemas/common/jsonContributionRegistry';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { CONTEXT_DEBUGGERS_AVAILABLE, IAdapterDescriptor, IAdapterManager, IConfig, IDebugAdapter, IDebugAdapterDescriptorFactory, IDebugAdapterFactory, IDebugConfiguration, IDebugSession, INTERNAL_CONSOLE_OPTIONS_SCHEMA } from 'vs/workbench/contrib/debug/common/debug';
import { Debugger } from 'vs/workbench/contrib/debug/common/debugger';
import { breakpointsExtPoint, debuggersExtPoint, launchSchema, presentationSchema } from 'vs/workbench/contrib/debug/common/debugSchemas';
import { TaskDefinitionRegistry } from 'vs/workbench/contrib/tasks/common/taskDefinitionRegistry';
import { launchSchemaId } from 'vs/workbench/services/configuration/common/configuration';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

export class AdapterManager extends Disposable implements IAdapterManager {

	private debuggers: Debugger[];
	private adapterDescriptorFactories: IDebugAdapterDescriptorFactory[];
	private debugAdapterFactories = new Map<string, IDebugAdapterFactory>();
	private debuggersAvailable: IContextKey<boolean>;
	private readonly _onDidRegisterDebugger = new Emitter<void>();
	private readonly _onDidDebuggersExtPointRead = new Emitter<void>();
	private breakpointModeIdsSet = new Set<string>();
	private debuggerWhenKeys = new Set<string>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IModeService private readonly modeService: IModeService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.adapterDescriptorFactories = [];
		this.debuggers = [];
		this.registerListeners();
		this.debuggersAvailable = CONTEXT_DEBUGGERS_AVAILABLE.bindTo(contextKeyService);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(this.debuggerWhenKeys)) {
				this.debuggersAvailable.set(this.hasEnabledDebuggers());
			}
		}));
	}

	private registerListeners(): void {
		debuggersExtPoint.setHandler((extensions, delta) => {
			delta.added.forEach(added => {
				added.value.forEach(rawAdapter => {
					if (!rawAdapter.type || (typeof rawAdapter.type !== 'string')) {
						added.collector.error(nls.localize('debugNoType', "Debugger 'type' can not be omitted and must be of type 'string'."));
					}

					if (rawAdapter.type !== '*') {
						const existing = this.getDebugger(rawAdapter.type);
						if (existing) {
							existing.merge(rawAdapter, added.description);
						} else {
							const dbg = this.instantiationService.createInstance(Debugger, this, rawAdapter, added.description);
							dbg.when?.keys().forEach(key => this.debuggerWhenKeys.add(key));
							this.debuggers.push(dbg);
						}
					}
				});
			});

			// take care of all wildcard contributions
			extensions.forEach(extension => {
				extension.value.forEach(rawAdapter => {
					if (rawAdapter.type === '*') {
						this.debuggers.forEach(dbg => dbg.merge(rawAdapter, extension.description));
					}
				});
			});

			delta.removed.forEach(removed => {
				const removedTypes = removed.value.map(rawAdapter => rawAdapter.type);
				this.debuggers = this.debuggers.filter(d => removedTypes.indexOf(d.type) === -1);
			});

			// update the schema to include all attributes, snippets and types from extensions.
			const items = (<IJSONSchema>launchSchema.properties!['configurations'].items);
			const taskSchema = TaskDefinitionRegistry.getJsonSchema();
			const definitions: IJSONSchemaMap = {
				'common': {
					properties: {
						'name': {
							type: 'string',
							description: nls.localize('debugName', "Name of configuration; appears in the launch configuration dropdown menu."),
							default: 'Launch'
						},
						'debugServer': {
							type: 'number',
							description: nls.localize('debugServer', "For debug extension development only: if a port is specified VS Code tries to connect to a debug adapter running in server mode"),
							default: 4711
						},
						'preLaunchTask': {
							anyOf: [taskSchema, {
								type: ['string']
							}],
							default: '',
							defaultSnippets: [{ body: { task: '', type: '' } }],
							description: nls.localize('debugPrelaunchTask', "Task to run before debug session starts.")
						},
						'postDebugTask': {
							anyOf: [taskSchema, {
								type: ['string'],
							}],
							default: '',
							defaultSnippets: [{ body: { task: '', type: '' } }],
							description: nls.localize('debugPostDebugTask', "Task to run after debug session ends.")
						},
						'presentation': presentationSchema,
						'internalConsoleOptions': INTERNAL_CONSOLE_OPTIONS_SCHEMA,
					}
				}
			};
			launchSchema.definitions = definitions;
			items.oneOf = [];
			items.defaultSnippets = [];
			this.debuggers.forEach(adapter => {
				const schemaAttributes = adapter.getSchemaAttributes(definitions);
				if (schemaAttributes && items.oneOf) {
					items.oneOf.push(...schemaAttributes);
				}
				const configurationSnippets = adapter.configurationSnippets;
				if (configurationSnippets && items.defaultSnippets) {
					items.defaultSnippets.push(...configurationSnippets);
				}
			});
			jsonRegistry.registerSchema(launchSchemaId, launchSchema);

			this._onDidDebuggersExtPointRead.fire();
		});

		breakpointsExtPoint.setHandler((extensions, delta) => {
			delta.removed.forEach(removed => {
				removed.value.forEach(breakpoints => this.breakpointModeIdsSet.delete(breakpoints.language));
			});
			delta.added.forEach(added => {
				added.value.forEach(breakpoints => this.breakpointModeIdsSet.add(breakpoints.language));
			});
		});
	}

	registerDebugAdapterFactory(debugTypes: string[], debugAdapterLauncher: IDebugAdapterFactory): IDisposable {
		debugTypes.forEach(debugType => this.debugAdapterFactories.set(debugType, debugAdapterLauncher));
		this.debuggersAvailable.set(this.hasEnabledDebuggers());
		this._onDidRegisterDebugger.fire();

		return {
			dispose: () => {
				debugTypes.forEach(debugType => this.debugAdapterFactories.delete(debugType));
			}
		};
	}

	hasEnabledDebuggers(): boolean {
		for (let [type] of this.debugAdapterFactories) {
			const dbg = this.getDebugger(type);
			if (dbg && dbg.enabled) {
				return true;
			}
		}

		return false;
	}

	createDebugAdapter(session: IDebugSession): IDebugAdapter | undefined {
		let factory = this.debugAdapterFactories.get(session.configuration.type);
		if (factory) {
			return factory.createDebugAdapter(session);
		}
		return undefined;
	}

	substituteVariables(debugType: string, folder: IWorkspaceFolder | undefined, config: IConfig): Promise<IConfig> {
		let factory = this.debugAdapterFactories.get(debugType);
		if (factory) {
			return factory.substituteVariables(folder, config);
		}
		return Promise.resolve(config);
	}

	runInTerminal(debugType: string, args: DebugProtocol.RunInTerminalRequestArguments, sessionId: string): Promise<number | undefined> {
		let factory = this.debugAdapterFactories.get(debugType);
		if (factory) {
			return factory.runInTerminal(args, sessionId);
		}
		return Promise.resolve(void 0);
	}

	registerDebugAdapterDescriptorFactory(debugAdapterProvider: IDebugAdapterDescriptorFactory): IDisposable {
		this.adapterDescriptorFactories.push(debugAdapterProvider);
		return {
			dispose: () => {
				this.unregisterDebugAdapterDescriptorFactory(debugAdapterProvider);
			}
		};
	}

	unregisterDebugAdapterDescriptorFactory(debugAdapterProvider: IDebugAdapterDescriptorFactory): void {
		const ix = this.adapterDescriptorFactories.indexOf(debugAdapterProvider);
		if (ix >= 0) {
			this.adapterDescriptorFactories.splice(ix, 1);
		}
	}

	getDebugAdapterDescriptor(session: IDebugSession): Promise<IAdapterDescriptor | undefined> {
		const config = session.configuration;
		const providers = this.adapterDescriptorFactories.filter(p => p.type === config.type && p.createDebugAdapterDescriptor);
		if (providers.length === 1) {
			return providers[0].createDebugAdapterDescriptor(session);
		} else {
			// TODO@AW handle n > 1 case
		}
		return Promise.resolve(undefined);
	}

	getDebuggerLabel(type: string): string | undefined {
		const dbgr = this.getDebugger(type);
		if (dbgr) {
			return dbgr.label;
		}

		return undefined;
	}

	get onDidRegisterDebugger(): Event<void> {
		return this._onDidRegisterDebugger.event;
	}

	get onDidDebuggersExtPointRead(): Event<void> {
		return this._onDidDebuggersExtPointRead.event;
	}

	canSetBreakpointsIn(model: ITextModel): boolean {
		const languageId = model.getLanguageId();
		if (!languageId || languageId === 'jsonc' || languageId === 'log') {
			// do not allow breakpoints in our settings files and output
			return false;
		}
		if (this.configurationService.getValue<IDebugConfiguration>('debug').allowBreakpointsEverywhere) {
			return true;
		}

		return this.breakpointModeIdsSet.has(languageId);
	}

	getDebugger(type: string): Debugger | undefined {
		return this.debuggers.find(dbg => strings.equalsIgnoreCase(dbg.type, type));
	}

	isDebuggerInterestedInLanguage(language: string): boolean {
		return !!this.debuggers
			.filter(d => d.enabled)
			.find(a => language && a.languages && a.languages.indexOf(language) >= 0);
	}

	async guessDebugger(gettingConfigurations: boolean, type?: string): Promise<Debugger | undefined> {
		if (type) {
			const adapter = this.getDebugger(type);
			return adapter && adapter.enabled ? adapter : undefined;
		}

		const activeTextEditorControl = this.editorService.activeTextEditorControl;
		let candidates: Debugger[] = [];
		let languageLabel: string | null = null;
		let model: IEditorModel | null = null;
		if (isCodeEditor(activeTextEditorControl)) {
			model = activeTextEditorControl.getModel();
			const language = model ? model.getLanguageId() : undefined;
			if (language) {
				languageLabel = this.modeService.getLanguageName(language);
			}
			const adapters = this.debuggers
				.filter(a => a.enabled)
				.filter(a => language && a.languages && a.languages.indexOf(language) >= 0);
			if (adapters.length === 1) {
				return adapters[0];
			}
			if (adapters.length > 1) {
				candidates = adapters;
			}
		}

		// We want to get the debuggers that have configuration providers in the case we are fetching configurations
		// Or if a breakpoint can be set in the current file (good hint that an extension can handle it)
		if ((!languageLabel || gettingConfigurations || (model && this.canSetBreakpointsIn(model as ITextModel))) && candidates.length === 0) { // {{SQL CARBON EDIT}} Cast to avoid compilation error - we assume vs code is doing the right thing here
			await this.activateDebuggers('onDebugInitialConfigurations');
			candidates = this.debuggers
				.filter(a => a.enabled)
				.filter(dbg => dbg.hasInitialConfiguration() || dbg.hasConfigurationProvider());
		}

		candidates.sort((first, second) => first.label.localeCompare(second.label));
		const picks: { label: string, debugger?: Debugger, type?: string }[] = candidates.map(c => ({ label: c.label, debugger: c }));

		if (picks.length === 0 && languageLabel) {
			if (languageLabel.indexOf(' ') >= 0) {
				languageLabel = `'${languageLabel}'`;
			}
			const message = nls.localize('CouldNotFindLanguage', "You don't have an extension for debugging {0}. Should we find a {0} extension in the Marketplace?", languageLabel);
			const buttonLabel = nls.localize('findExtension', "Find {0} extension", languageLabel);
			const showResult = await this.dialogService.show(Severity.Warning, message, [buttonLabel, nls.localize('cancel', "Cancel")], { cancelId: 1 });
			if (showResult.choice === 0) {
				await this.commandService.executeCommand('debug.installAdditionalDebuggers', languageLabel);
			}
			return undefined;
		}

		picks.push({ type: 'separator', label: '' });
		const placeHolder = nls.localize('selectDebug', "Select environment");

		picks.push({ label: languageLabel ? nls.localize('installLanguage', "Install an extension for {0}...", languageLabel) : nls.localize('installExt', "Install extension...") });
		return this.quickInputService.pick<{ label: string, debugger?: Debugger }>(picks, { activeItem: picks[0], placeHolder })
			.then(picked => {
				if (picked && picked.debugger) {
					return picked.debugger;
				}
				if (picked) {
					this.commandService.executeCommand('debug.installAdditionalDebuggers', languageLabel);
				}
				return undefined;
			});
	}

	async activateDebuggers(activationEvent: string, debugType?: string): Promise<void> {
		const promises: Promise<any>[] = [
			this.extensionService.activateByEvent(activationEvent),
			this.extensionService.activateByEvent('onDebug')
		];
		if (debugType) {
			promises.push(this.extensionService.activateByEvent(`${activationEvent}:${debugType}`));
		}
		await Promise.all(promises);
	}
}
