#!/usr/bin/env node

const { execSync } = require('child_process');
const commander = require('commander');
const fssync = require('fs');
const fs = fssync.promises;
const git = require('simple-git');
const glob = require('glob-gitignore');
const parseGitignore = require('parse-gitignore');
const path = require('path');
const semver = require('semver');
const toml = require('toml');

const appRoot = path.dirname(require.main.filename);
const packagejson = require('./package.json');

const LOGVERBOSITY = {
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
};

const defaultConfig = fssync.readFileSync(`${appRoot}/VERSION`);

const program = new commander.Command();
program.version(packagejson.version);
program.description(packagejson.description);
program.option('-v, --verbosity <number>', 'log verbosity level. Can be 1, 2, or 3.', 1);

program
    .command('build')
    .description('Build Nextcloud')
    .option('--custom-config <path>', `Custom ${packagejson.name} config file to use for building Nextcloud. Defaults to the config shipped with ${packagejson.name} which is currently for ${defaultConfig}`)
    .option('--build-dir <path>', 'Directory in which to build Nextcloud', './build')
    .option('--nc-version <version>', 'Nextcloud version to build', defaultConfig.toString())
    .option('--exec-krankerl-cmds <true|false>', 'Execute commands defined in Krankerl.toml config files. Defaults to config file value or false')
    .option('--patches <string>', 'Comma seperated list of globs for patches to apply', "")
    .action(build);

program.parse(process.argv);

const options = program.opts();

/**
 * Ensure Node version is a supported version
 */
function checkNodeVersion () {
    let engineRequirement = "*";
    if (packagejson.engines && packagejson.engines.node) {
        engineRequirement = packagejson.engines.node;
    }
    if (!semver.satisfies(process.version, engineRequirement)) {
        console.error(`Unsupported Node version. ${engineRequirement} required`);
        process.exit(1);
    }
}

async function build (cmd) {
    checkNodeVersion();

    const configLocation = cmd.config || `${appRoot}/configs/${cmd.ncVersion}.json`;
    const buildDir = cmd.buildDir;
    const config = JSON.parse(await fs.readFile(configLocation));

    // Config defaults
    config.apps = config.apps || [];
    config.exclude = config.exclude || [];
    config.globalExclude = config.globalExclude || [];
    config.patches = config.patches || [];
    config.includedPatches = config.includedPatches || [];

    // Setup build directory
    if (fsExists(buildDir)) {
        console.error(`${buildDir} directory already exists. Please remove the directory before beginning`);
        return;
    }
    await fs.mkdir(buildDir);

    // Configure reusable values
    const version = config.version;

    // Clone server repo and checkout to provided version
    const buildGit = git(buildDir);
    logMessage("Server: Cloning Repo");
    await buildGit.clone(config.repo, config.name, { '--recursive': null, '--depth': 1, '--branch': version });
    logMessage("Server: Clone Complete");
    const serverPath = `${buildDir}/${config.name}`;
    const serverGit = git(serverPath);
    await serverGit.submoduleUpdate();
    const versionHash = await serverGit.revparse(['HEAD']);
    await fs.writeFile(`${serverPath}/version.php`, versionFile((await fs.readFile(`${serverPath}/version.php`)).toString(), versionHash, { versionString: config.versionString, updateChannel: config.updateChannel }));

    // Remove excluded files from repo
    globRemove(config.exclude, `${buildDir}/${config.name}`);

    const appList = [];

    Object.keys(config.apps).forEach(appName => {
        const appConfig = config.apps[appName];

        // Set up default values for each app
        appConfig.version = appConfig.version || config.version;
        appConfig.exclude = [...config.globalExclude, ...(appConfig.exclude || [])];
        appConfig.appsDir = path.resolve(`${buildDir}/${config.name}`, appConfig.appsDir || "./apps");
        appConfig.krankerlCommands = setIfNotUndefined(cmd.execKrankerlCmds, appConfig.krankerlCommands, false);

        // Add the app
        appList.push(addApp(appName, appConfig.appsDir, appConfig));
    });

    await Promise.all(appList);

    // Apply given patches
    if (config.patches.length > 0 || (cmd.patches && cmd.patches.length > 0) || config.includedPatches.length > 0) {
        logMessage("Setup complete. Applying patches", LOGVERBOSITY.LOW);
    }

    await buildGit.init();

    // Apply patches given in the file as included patches
    if (config.includedPatches && config.includedPatches.length > 0) {
        const patches = glob.sync(globConvert(config.includedPatches), { cwd: appRoot });
        await applyPatchesToBuild(patches.map(x => path.resolve(appRoot, x)), config, buildGit);
    }

    // Apply patches given as extra patches in config
    if (config.patches && config.patches.length > 0) {
        const configDir = path.dirname(configLocation);
        const patches = glob.sync(globConvert(config.patches), { cwd: configDir });
        await applyPatchesToBuild(patches.map(x => path.resolve(configDir, x)), config, buildGit);
    }

    if (cmd.patches && cmd.patches.length > 0) {
        const cmdPatches = glob.sync((cmd.patches || "").split(","), { cwd: process.cwd() });
        await applyPatchesToBuild(cmdPatches.map(x => path.resolve(process.cwd(), x)), config, buildGit);
    }

    logMessage("Clean up temporary files");

    removeListed([".git"], buildDir);

    logMessage("Build complete!");
}

/**
 * Apply a given array of patch files paths to the build
 * @async
 * @param {Array<String>} patches patches to apply
 * @param config the build config
 * @param buildGit simple-git to build directory
 */
async function applyPatchesToBuild (patches, config, buildGit) {
    for (let i = 0; i < patches.length; i++) {
        logMessage(`PATCHES: Applying patch ${patches[i]}`, LOGVERBOSITY.HIGH);
        await buildGit.raw([
            'apply',
            '--directory',
            config.name,
            patches[i],
        ]).catch(err => {
            console.error(`PATCHES: Could not apply '${patches[i]}'. ${err.toString()}`);
            process.exit(1);
        });
    }
}

/**
 * Does a file or directory exist at the given path
 * @param {String} fse The path
 * @returns {Boolean} Whether a file or directory exists at the given path
 */
function fsExists (fse) {
    try {
        fssync.accessSync(fse);
    } catch (e) {
        return false;
    }
    return true;
}

/**
 * Add a Nextcloud app
 * @param {String} appName Name of Nextcloud app to add
 * @param {String} appsDir Apps directory in Nextcloud
 * @param {Object} appConfig App Config object
 */
async function addApp (appName, appsDir, appConfig) {
    const appDir = `${appsDir}/${appName}`;
    if (appConfig.remove && fsExists(appDir)) {
        removeListed([appDir], "");
        if (appConfig.remove !== "continue") {
            return;
        }
    }
    if (appConfig.repo) {
        logMessage(`${appName}: Cloning repo`);
        await git(appsDir).clone(appConfig.repo, appName, { '--recursive': null, '--depth': 1, '--branch': appConfig.version });
        logMessage(`${appName}: Repo clone done`);
        const appGit = git(appDir);
        await appGit.submoduleUpdate();
    }

    await arbitraryCommandsApp(appName, appDir, appConfig);
    await krankerlEnabledAppSetup(appName, appDir, appConfig);
    await nextcloudIgnore(appName, appDir, appConfig);
    await globRemove(appConfig.exclude, appDir);
}

/**
 * Run commands given in before_cmds
 * @param {String} appName Name of Nextcloud app to add
 * @param {String} appDir Apps directory in Nextcloud
 * @param {Object} appConfig App Config object
 */
async function arbitraryCommandsApp (appName, appDir, appConfig) {
    logMessage(`${appName}: running config before_cmds`, LOGVERBOSITY.MEDIUM);
    if (appConfig.before_cmds && appConfig.before_cmds.length > 0) {
        appConfig.before_cmds.forEach(cmd => {
            execSync(cmd, { cwd: appDir, stdio: 'inherit' });
        });
    }
}

/**
 * Check if Krankerl is enabled then run Krankerl config
 * @param {String} appName Name of Nextcloud app to add
 * @param {String} appDir Apps directory in Nextcloud
 * @param {Object} appConfig App Config object
 */
async function krankerlEnabledAppSetup (appName, appDir, appConfig) {
    const krankerlEnabled = fsExists(`${appDir}/krankerl.toml`);
    if (!krankerlEnabled) {
        return;
    }
    logMessage(`${appName}: Krankerl config found. Using config`, LOGVERBOSITY.MEDIUM);
    const krankerlConfig = toml.parse(await fs.readFile(`${appDir}/krankerl.toml`));

    if (krankerlConfig.package) {
        // run all `before_cmds` commands
        if (appConfig.krankerlCommands && krankerlConfig.package.before_cmds) {
            krankerlConfig.package.before_cmds.forEach(cmd => {
                execSync(cmd, { cwd: appDir, stdio: 'inherit' });
            });
        }

        // Remove all excluded files
        if (krankerlConfig.package.exclude) {
            globRemove(krankerlConfig.package.exclude, appDir);
        }
    }
    logMessage(`${appName}: Krankerl jobs finished`, LOGVERBOSITY.MEDIUM);
}

/**
 * Check if .nextcloudignore is available then remove files listed in .nextcloudignore
 * @param {String} appName Name of Nextcloud app to add
 * @param {String} appDir Apps directory in Nextcloud
 * @param {Object} appConfig App Config object
 */
async function nextcloudIgnore (appName, appDir, appConfig) {
    const nextcloudIgnoreEnabled = fsExists(`${appDir}/.nextcloudignore`);
    if (!nextcloudIgnoreEnabled) {
        return;
    }
    logMessage(`${appName}: .nextcloudignore found. Using ignore list`, LOGVERBOSITY.MEDIUM);
    // Read in file then split on new lines
    const toIgnore = parseGitignore(await fs.readFile(`${appDir}/.nextcloudignore`));
    // Run glob on toIgnore
    globRemove(toIgnore, appDir);
}

/**
 * Remove a given array of globs of files or directories
 * @param {Array<String>} globs Array of globs for files or directories to remove
 * @param {String} cwd Working directory from which to remove the list of files or directories
 */
function globRemove (globs, cwd) {
    const torm = glob.sync(globConvert(globs), { cwd: cwd });
    removeListed(torm, cwd);
}

/**
 * Remove a given array of files or directories
 * @param {Array<String>} listed Array of files or directories to remove
 * @param {String} cwd Working directory from which to remove the list of files or directories
 */
function removeListed (listed, cwd) {
    listed.forEach(rm => {
        const file = path.resolve(cwd, rm);
        if (!fsExists(file)) {
            return;
        }
        logMessage(`Delete: Removing ${file}`, LOGVERBOSITY.HIGH);
        const lstat = fssync.lstatSync(file);
        // If it is a file
        if (lstat.isFile() || lstat.isSymbolicLink()) {
            fssync.unlinkSync(file);
            return;
        }
        if (lstat.isDirectory()) {
            fssync.rmdirSync(file, { recursive: true });
        }
    });
}

/**
 * Take the version file in git and create a final release version.php file.
 * @param {String} original content of the version.php file in git
 * @param {String} hash git hash of the version being built
 * @param {Object} [config] extra optional config
 * @param {String} [config.versionString] override version string in the version file
 * @param {String} [config.updateChannel] override the update channel string in the version file
 * @returns {String} content of final release version.php file
 */
function versionFile (original, hash, config) {
    if (typeof config !== "object") {
        config = {};
    }
    const originalArr = original.split("\n");
    logMessage(`Creating version.php file`, LOGVERBOSITY.MEDIUM);
    let tr = "<?php" + "\n";
    tr += findLineWithString(originalArr, "$OC_Version") + "\n";
    tr += defaultOrReplaceIfSet(findLineWithString(originalArr, "$OC_VersionString"), config.versionString) + "\n";
    tr += defaultOrReplaceIfSet(findLineWithString(originalArr, "$OC_Channel"), config.updateChannel) + "\n";
    tr += findLineWithString(originalArr, "$vendor") + "\n";
    tr += replacePHPString(findLineWithString(originalArr, "$OC_Build"), `${new Date().toISOString()} ${hash}`) + "\n";
    const upgradeStart = originalArr.findIndex(s => s.includes("$OC_VersionCanBeUpgradedFrom"));
    for (let i = upgradeStart; originalArr[i] !== ""; i++) {
        tr += originalArr[i] + "\n";
    }
    logMessage(`version.php file created`, LOGVERBOSITY.MEDIUM);
    return tr;
}

/**
 * Do a replacePHPString if replaceWith is set but return given directly if replaceWith is undefined
 * @param {String} given
 * @param {String} replaceWith
 * @returns {String}
 */
function defaultOrReplaceIfSet (given, replaceWith) {
    if (typeof replaceWith !== 'undefined') {
        return replacePHPString(given, replaceWith);
    }
    return given;
}

/**
 * Find a string in an array of strings that include a given string
 * @param {Array<String>} lines array to search
 * @param {String} content string to search for
 * @returns {String} the string that was found
 */
function findLineWithString (lines, content) {
    return (lines.filter(s => s.includes(content)) || [""])[0];
}

/**
 * Replace a line with an empty PHP string with the given replace. Any instance of {pre} will be replace with the preexisting string
 * @param {String} toReplace The line to replace
 * @param {String} replaceWith The string to replace it with
 * @returns {String} the string with content replaced
 */
function replacePHPString (toReplace, replaceWith) {
    const regex = /('(.*)')|("(.*))"/g;
    const current = (toReplace.match(regex) || [""])[0].slice(1, -1);
    const replace = replaceWith.replace("{pre}", current);
    return toReplace.replace(regex, `'${replace}'`);
}

/**
 * Write log message to console
 * @param {String} message Message to log
 * @param {Number} [logverbosity] Log verbosity. Defaults to LOGVERBOSITY.LOW
 */
function logMessage (message, logverbosity) {
    logverbosity = logverbosity || LOGVERBOSITY.LOW;
    if (logverbosity <= options.verbosity) {
        // eslint-disable-next-line
        console.log(message);
    }
}

/**
 * Returns the first argument that is not undefined
 * @param {Array} given
 * @returns {*|undefined}
 */
function setIfNotUndefined (...given) {
    for (let i = 0; i < given.length; i++) {
        if (typeof given[i] !== "undefined") {
            return given[i];
        }
    }
    return undefined;
}

/**
 * Convert Glob from .gitignore style to glob style
 * @param {Array<String>} globtc Glob in .gitignore style
 * @returns {Array<String>} Glob in glob style
 */
function globConvert (globtc) {
    return globtc
        // Separate out negations to join later. This makes it easier to work on the patterns
        .map(p => p[0] === '!' ? ['!', p.substr(1)] : ['', p])
        // Add `**/` for patterns that do not start with `/`
        .map(p => p[1][0] === "/" ? [p[0], p[1].substr(1)] : [p[0], `**/${p[1]}`])
        // Rejoin separated negations
        .map(p => p.join(''));
}
