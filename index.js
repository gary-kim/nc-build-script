const { execSync } = require('child_process');
const commander = require('commander');
const fssync = require('fs');
const fs = fssync.promises;
const git = require('simple-git/promise');
const glob = require('glob-gitignore');
const parseGitignore = require('parse-gitignore');
const path = require('path');
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
program.option('-v <level>, --verbosity <level>', 'log verbosity level. Can be 1, 2, or 3.', 1);

program
    .command('build')
    .description('Build Nextcloud')
    .option('--custom-config <path>', `Custom ${packagejson.name} config file to use for building Nextcloud. Defaults to the config shipped with ${packagejson.name} which is currently for ${defaultConfig}`)
    .option('--build-dir <path>', 'Directory in which to build Nextcloud', './build')
    .option('--nc-version <version>', 'Nextcloud version to build', defaultConfig.toString())
    .option('--exec-krankerl-cmds <true|false>', 'Execute commands defined in Krankerl.toml config files. Defaults to config file value or false')
    .action(build);

program.parse(process.argv);

async function build (cmd) {
    const configLocation = cmd.config || `${appRoot}/configs/${cmd.ncVersion}.json`;
    const buildDir = cmd.buildDir;
    const config = JSON.parse(await fs.readFile(configLocation));

    // Config defaults
    config.exclude = config.exclude || [];
    config.globalExclude = config.globalExclude || [];

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
    await buildGit.clone(config.repo, config.name, ['--recursive']);
    logMessage("Server: Clone Complete");
    const serverGit = git(`${buildDir}/${config.name}`);
    await serverGit.checkout(version);
    await serverGit.submoduleUpdate();

    // Remove excluded files from repo
    globRemove(config.exclude, `${buildDir}/${config.name}`);

    Object.keys(config.apps).forEach(appName => {
        const appConfig = config.apps[appName];

        // Set up default values for each app
        appConfig.version = appConfig.version || config.version;
        appConfig.exclude = [...config.globalExclude, ...(appConfig.exclude || [])];
        appConfig.appsDir = path.resolve(`${buildDir}/${config.name}`, appConfig.appsDir || "./apps");
        appConfig.krankerlCommands = setIfNotUndefined(cmd.execKrankerlCmds, appConfig.krankerlCommands, false);

        // Add the app
        addApp(appName, appConfig.appsDir, appConfig);
    });
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
        await git(appsDir).clone(appConfig.repo, appName, ['--recursive']);
        logMessage(`${appName}: Repo clone done`);
        const appGit = git(appDir);
        await appGit.checkout(appConfig.version);
        await appGit.submoduleUpdate();
    }

    await krankerlEnabledAppSetup(appName, appDir, appConfig);
    await nextcloudIgnore(appName, appDir, appConfig);
    globRemove(appConfig.exclude, appDir);
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
 * Write log message to console
 * @param {String} message Message to log
 * @param {Number} logverbosity Log verbosity
 */
function logMessage (message, logverbosity) {
    logverbosity = logverbosity || 1;
    if (logverbosity <= program.V) {
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
