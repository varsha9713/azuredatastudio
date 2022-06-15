const fs = require('fs');
const path = require('path');
const glob = require('glob');
const iLibInstrument = require('istanbul-lib-instrument');
const iLibCoverage = require('istanbul-lib-coverage');
const iLibSourceMaps = require('istanbul-lib-source-maps');
const iLibReport = require('istanbul-lib-report');
const iReports = require('istanbul-reports');

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

const REPO_PATH = toUpperDriveLetter(path.join(__dirname, '../..'));

function fixPath(brokenPath) {
	const startIndex = brokenPath.lastIndexOf(REPO_PATH);
	if (startIndex === -1) {
		return toLowerDriveLetter(brokenPath);
	}
	return toLowerDriveLetter(brokenPath.substr(startIndex));
}

const instrumenter = iLibInstrument.createInstrumenter();
glob(path.join(REPO_PATH, 'out/sql/**/**.js'), { ignore: '**/test/**' }, function (error, files) {
	if (error) {
		console.log(error);
		// return clb(error);
	}
	try {
		// Fill into Mocha
		files.forEach(f => {
			let map = undefined;
			let contents = fs.readFileSync(f).toString();
			try {
				map = JSON.parse(fs.readFileSync(`${f}.map`).toString());
			} catch (err) {
				console.log(err);
				// missing source map...
			}
			const instrumentedContents = instrumenter.instrumentSync(contents, f, map);
			fs.writeFileSync(f, instrumentedContents);
		});
	}
	catch (error) {
		console.log(error);
		// return clb(error);
	}
});

// This doesn't work unfortunately - renderer code is loaded via script tags which use BrowserScriptLoader from loader.js
// not the NodeScriptLoader which allows this instrumenter
// Maybe try disabling loading via script tags (preferScriptTags)
// const instrumenter = iLibInstrument.createInstrumenter();
// loaderConfig.nodeInstrumenter = (contents, source) => {
// 	// Try to find a .map file
// 	let map = undefined;
// 	try {
// 		map = JSON.parse(readFileSync(`${source}.map`).toString());
// 	} catch (err) {
// 		console.log(err);
// 		// missing source map...
// 	}
// 	return instrumenter.instrumentSync(contents, source, map);
// };
