/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const loader = require('./vs/loader');
const bootstrap = require('./bootstrap');
const performance = require('./vs/base/common/performance');
const fs = require('fs');
const path = require('path');
const iLibInstrument = require('istanbul-lib-instrument');
const iLibCoverage = require('istanbul-lib-coverage');
const iLibSourceMaps = require('istanbul-lib-source-maps');
const iLibReport = require('istanbul-lib-report');
const iReports = require('istanbul-reports');

// Bootstrap: NLS
const nlsConfig = bootstrap.setupNLS();

const instrumenter = iLibInstrument.createInstrumenter();
// Bootstrap: Loader
loader.config({
	baseUrl: bootstrap.fileUriFromPath(__dirname, { isWindows: process.platform === 'win32' }),
	catchError: true,
	nodeRequire: require,
	nodeMain: __filename,
	'vs/nls': nlsConfig,
	amdModulesPattern: /^(vs|sql)\//,
	recordStats: true,
	// TODO Only do this when specifically ran with coverage, easiest is probably through env var
	nodeInstrumenter: (contents, source) => {
		// Try to find a .map file
		let map = undefined;
		try {
			map = JSON.parse(fs.readFileSync(`${source}.map`).toString());
		} catch (err) {
			console.log(err);
			// missing source map...
		}
		return instrumenter.instrumentSync(contents, source, map);
		// return contents;
	}
});

const REPO_PATH = toUpperDriveLetter(path.join(__dirname, '../'));

// TODO - Have this happen either on app close or when instructed (such as calling this when tests are finished)
setTimeout(() => {
	const mapStore = iLibSourceMaps.createSourceMapStore();
	const coverageMap = iLibCoverage.createCoverageMap(global.__coverage__);
	return mapStore.transformCoverage(coverageMap).then((transformed) => {
		// Paths come out all broken
		let newData = Object.create(null);
		Object.keys(transformed.data).forEach((file) => {
			const entry = transformed.data[file];
			const fixedPath = fixPath(entry.path);
			if (fixedPath.includes(`/vs/`) || fixedPath.includes('\\vs\\') || path.basename(fixedPath) === 'marked.js') { return; } // {{SQL CARBON EDIT}} skip vscode files and imported marked.js
			// @ts-ignore
			entry.data.path = fixedPath;
			newData[fixedPath] = entry;
		});
		transformed.data = newData;
		const context = iLibReport.createContext({
			dir: path.join(REPO_PATH, `.build/coverage-amd`),
			coverageMap: transformed
		});
		const tree = context.getTree('flat');

		[
			iReports.create('json'),
			iReports.create('lcov'),
			iReports.create('html'),
			iReports.create('cobertura')
		// @ts-ignore
		].forEach(report => tree.visit(report, context));
	});
}, 60000);

// TODO - Move all these common functions into single place for all bootstrap stuff to use (and ideally coverage.js as well)
function toUpperDriveLetter(str) {
	if (/^[a-z]:/.test(str)) {
		return str.charAt(0).toUpperCase() + str.substr(1);
	}
	return str;
}

function toLowerDriveLetter(str) {
	if (/^[A-Z]:/.test(str)) {
		return str.charAt(0).toLowerCase() + str.substr(1);
	}
	return str;
}

function fixPath(brokenPath) {
	const startIndex = brokenPath.lastIndexOf(REPO_PATH);
	if (startIndex === -1) {
		return toLowerDriveLetter(brokenPath);
	}
	return toLowerDriveLetter(brokenPath.substr(startIndex));
}

// Running in Electron
if (process.env['ELECTRON_RUN_AS_NODE'] || process.versions['electron']) {
	loader.define('fs', ['original-fs'], function (originalFS) {
		return originalFS;  // replace the patched electron fs with the original node fs for all AMD code
	});
}

// Pseudo NLS support
if (nlsConfig && nlsConfig.pseudo) {
	loader(['vs/nls'], function (nlsPlugin) {
		nlsPlugin.setPseudoTranslation(nlsConfig.pseudo);
	});
}

exports.load = function (entrypoint, onLoad, onError) {
	if (!entrypoint) {
		return;
	}

	// code cache config
	if (process.env['VSCODE_CODE_CACHE_PATH']) {
		loader.config({
			nodeCachedData: {
				path: process.env['VSCODE_CODE_CACHE_PATH'],
				seed: entrypoint
			}
		});
	}

	onLoad = onLoad || function () { };
	onError = onError || function (err) { console.error(err); };

	performance.mark(`code/fork/willLoadCode`);
	loader([entrypoint], onLoad, onError);
};
