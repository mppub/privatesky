const path = require("path");
const os = require("os");
const fs = require("fs");
const { storeFileAsync } = require("../tir-utils");
const Logger = require("../Logger");

const logger = new Logger("[TIR]");

const mkdirAsync = $$.promisify(fs.mkdir);
const writeFileAsync = $$.promisify(fs.writeFile);

function getCompleteOptions(options, defaultOptions) {
    const completeOptions = { ...options };
    Object.keys(defaultOptions).forEach((defaultOptionName) => {
        if (completeOptions[defaultOptionName] == null) {
            completeOptions[defaultOptionName] = defaultOptions[defaultOptionName];
        }
    });
    if (!completeOptions.storageFolder) {
        completeOptions.storageFolder = fs.mkdtempSync(path.join(os.tmpdir(), "psk_"));
        logger.info(`Creating random storage folder: ${completeOptions.storageFolder}`);
    }

    if (!completeOptions.domains) {
        completeOptions.domains = [];
    }

    if (completeOptions.includeDefaultDomains) {
        const defaultDomains = ["default", "test1", "test2"];
        defaultDomains
            .filter((defaultDomainName) => {
                const isDomainAlreadyConfigured = completeOptions.domains.some((existingDomain) => {
                    existingDomain = getDomainNameAndConfig(existingDomain);
                    return existingDomain.name === defaultDomainName;
                });
                return !isDomainAlreadyConfigured;
            })
            .forEach((domain) => completeOptions.domains.push(domain));
    }

    return completeOptions;
}

function getConfigFolderPath(storageFolder) {
    return path.join(storageFolder, "/external-volume/config");
}

function storeRequiredEnvironmentVariables(storageFolder, nodeUrl) {
    //we define the PSK_CONFIG_LOCATION according to our test folder structure
    process.env.PSK_CONFIG_LOCATION = getConfigFolderPath(storageFolder);

    process.env.vmq_channel_storage = storageFolder;

    const opendsu = require("opendsu");
    const consts = opendsu.constants;
    const system = opendsu.loadApi("system");
    system.setEnvironmentVariable(consts.BDNS_ROOT_HOSTS, nodeUrl);
    process.env[consts.BDNS_ROOT_HOSTS] = nodeUrl;
}

async function loadValidatorDIDInstanceAsync(validatorDID) {
    if (typeof validatorDID === "string") {
        const w3cDID = require("opendsu").loadAPI("w3cdid");
        validatorDID = await $$.promisify(w3cDID.resolveDID)(validatorDID);
    }
    return validatorDID;
}

async function getValidatorDIDAsync(options) {
    let validatorDID = options.validatorDID;
    if (!validatorDID) {
        const w3cDID = require("opendsu").loadApi("w3cdid");
        const DID = await $$.promisify(w3cDID.createIdentity)("demo", "id");
        validatorDID = DID.getIdentifier();
    }
    return validatorDID;
}

function getValidators(options, validatorDID, nodeUrl) {
    let validators = options.validators;
    if (!validators) {
        // if nothing is specified for the validators, then consider self as validators
        validators = [{ DID: validatorDID, URL: nodeUrl }];
    }
    return validators;
}

function getBDNSEntries(options, nodeUrl, validators) {
    let bdns = options.bdns;
    if (!bdns) {
        // constructor BDNS from configured domains
        bdns = {};
        options.domains.forEach((domain) => {
            domain = getDomainNameAndConfig(domain);
            bdns[domain.name] = {
                replicas: [],
                notifications: [nodeUrl],
                brickStorages: [nodeUrl],
                anchoringServices: [nodeUrl],
                contractServices: [nodeUrl],
                validators,
            };
        });
    }
    return bdns;
}

async function createApiHubInstanceAsync(...args) {
    const pskApiHub = require("apihub");
    logger.info("Starting apihub instance...", args);
    return $$.promisify(pskApiHub.createInstance)(...args);
}

async function createApiHubInstanceWorkerAsync(apiHubOptions) {
    logger.info("Starting apihub worker instance...", apiHubOptions);
    const { Worker } = require("worker_threads");
    const worker = new Worker(path.join(__dirname, "./ApiHubTestNodeLauncherWorkerBoot.js"), {
        workerData: apiHubOptions,
    });

    return new Promise((resolve, reject) => {
        worker.on("message", (result) => {
            resolve(result);
            if (apiHubOptions.contractBuildFilePath) {
                logger.debug("Terminating apihub worker...");
                // worker should only be used for creating the contract domain
                worker.terminate();
            }
        });
        worker.on("error", (err) => {
            logger.error("The apihub worker has encountered an error", err);
            reject(err);
        });
    });
}

function getDomainNameAndConfig(domain) {
    const domainName = typeof domain === "string" ? domain : domain.name;
    const domainConfig = typeof domain === "string" ? {} : domain.config;
    return { name: domainName, config: domainConfig };
}

async function updateDomainConfigsWithContractConstitutionAsync(storageFolder, domains, domainSeed) {
    logger.info("Updating domain configs...");
    const updatedDomainConfigs = domains.map((domain) => {
        const { name, config } = getDomainNameAndConfig(domain);
        if (!config.contracts) {
            config.contracts = {};
        }
        config.contracts.constitution = domainSeed;

        return { name, config };
    });
    await storeServerDomainConfigsAsync(storageFolder, updatedDomainConfigs);
}

async function storeServerConfigAsync(storageFolder, content) {
    let configFolderPath = getConfigFolderPath(storageFolder);
    await storeFileAsync(configFolderPath, "apihub.json", JSON.stringify(content));
}

async function storeServerDomainConfigsAsync(storageFolder, domains) {
    let configFolderPath = getConfigFolderPath(storageFolder);
    const domainConfigsFolderPath = path.join(configFolderPath, "domains");
    for (let index = 0; index < domains.length; index++) {
        const domain = domains[index];
        const { name, config } = getDomainNameAndConfig(domain);

        await storeFileAsync(domainConfigsFolderPath, `${name}.json`, JSON.stringify(config));
    }
}

async function storeDBNSAsync(storageFolder, content) {
    let bdnsEntries = [];
    if (typeof content === "object") {
        bdnsEntries = Object.keys(content).map((domain) => {
            return {
                domain,
                content: content[domain],
            };
        });
        content = JSON.stringify(content);
    }

    let configFolderPath = getConfigFolderPath(storageFolder);

    await mkdirAsync(configFolderPath, { recursive: true });
    await writeFileAsync(path.join(configFolderPath, "bdns.hosts"), content);

    if (bdnsEntries.length) {
        const bdnsConfigsFolderPath = path.join(configFolderPath, "bdns");
        await mkdirAsync(bdnsConfigsFolderPath, { recursive: true });

        for (let index = 0; index < bdnsEntries.length; index++) {
            const { domain, content } = bdnsEntries[index];
            await storeFileAsync(bdnsConfigsFolderPath, `${domain}.json`, JSON.stringify(content));
        }
    }
}

async function runOctopusScriptAsync(scriptName, args) {
    const scriptPath = path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, `./node_modules/octopus/scripts/${scriptName}.js`);

    const pskBundlesPath = "./psknode/bundles";

    const child_process = require("child_process");
    const forkedProcess = child_process.fork(scriptPath, [`--bundles=${pskBundlesPath}`, ...args], {
        cwd: process.env.PSK_ROOT_INSTALATION_FOLDER,
    });

    return new Promise((resolve, reject) => {
        forkedProcess.on("exit", function (code) {
            if (code !== 0) {
                return reject(code);
            }

            resolve();
        });
    });
}

module.exports = {
    getCompleteOptions,
    storeRequiredEnvironmentVariables,
    loadValidatorDIDInstanceAsync,
    getValidatorDIDAsync,
    getValidators,
    getBDNSEntries,
    createApiHubInstanceAsync,
    createApiHubInstanceWorkerAsync,
    updateDomainConfigsWithContractConstitutionAsync,
    storeServerConfigAsync,
    storeServerDomainConfigsAsync,
    storeDBNSAsync,
    runOctopusScriptAsync,
};
