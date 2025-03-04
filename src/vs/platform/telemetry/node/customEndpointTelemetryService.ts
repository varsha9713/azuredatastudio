/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from 'vs/base/common/network';
import { Client as TelemetryClient } from 'vs/base/parts/ipc/node/ipc.cp';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ILoggerService } from 'vs/platform/log/common/log';
import { ICustomEndpointTelemetryService, ITelemetryData, ITelemetryEndpoint, ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryAppenderClient } from 'vs/platform/telemetry/common/telemetryIpc';
import { TelemetryLogAppender } from 'vs/platform/telemetry/common/telemetryLogAppender';
import { TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
export class CustomEndpointTelemetryService implements ICustomEndpointTelemetryService {
	declare readonly _serviceBrand: undefined;

	private customTelemetryServices = new Map<string, ITelemetryService>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) { }

	private async getCustomTelemetryService(endpoint: ITelemetryEndpoint): Promise<ITelemetryService> {
		if (!this.customTelemetryServices.has(endpoint.id)) {
			const { machineId, sessionId } = await this.telemetryService.getTelemetryInfo();
			const telemetryInfo: { [key: string]: string } = Object.create(null);
			telemetryInfo['common.vscodemachineid'] = machineId;
			telemetryInfo['common.vscodesessionid'] = sessionId;
			const args = [endpoint.id, JSON.stringify(telemetryInfo), endpoint.aiKey];
			const client = new TelemetryClient(
				FileAccess.asFileUri('bootstrap-fork', require).fsPath,
				{
					serverName: 'Debug Telemetry',
					timeout: 1000 * 60 * 5,
					args,
					env: {
						ELECTRON_RUN_AS_NODE: 1,
						VSCODE_PIPE_LOGGING: 'true',
						VSCODE_AMD_ENTRYPOINT: 'vs/workbench/contrib/debug/node/telemetryApp'
					}
				}
			);

			const channel = client.getChannel('telemetryAppender');
			const appenders = [
				new TelemetryAppenderClient(channel),
				new TelemetryLogAppender(this.loggerService, this.environmentService, `[${endpoint.id}] `),
			];

			this.customTelemetryServices.set(endpoint.id, new TelemetryService({
				appenders,
				sendErrorTelemetry: endpoint.sendErrorTelemetry
			}, this.configurationService));
		}

		return this.customTelemetryServices.get(endpoint.id)!;
	}

	async publicLog(telemetryEndpoint: ITelemetryEndpoint, eventName: string, data?: ITelemetryData): Promise<void> {
		const customTelemetryService = await this.getCustomTelemetryService(telemetryEndpoint);
		await customTelemetryService.publicLog(eventName, data);
	}

	async publicLogError(telemetryEndpoint: ITelemetryEndpoint, errorEventName: string, data?: ITelemetryData): Promise<void> {
		const customTelemetryService = await this.getCustomTelemetryService(telemetryEndpoint);
		await customTelemetryService.publicLogError(errorEventName, data);
	}
}
