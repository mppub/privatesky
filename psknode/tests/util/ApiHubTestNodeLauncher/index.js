const { sleepAsync, getRandomPort, isPortAvailableAsync } = require("../tir-utils");

const {
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
} = require("./launcher-utils");
const Logger = require("../Logger");

const logger = new Logger("[TIR]");

const defaultOptions = {
    maxTries: 100,
    rootFolder: null,
    serverConfig: {},
    domains: null,
    bdns: null,
    validatorDID: null,
    validators: null,
    useWorker: false,
    bricksLedgerConfig: null,
    includeDefaultDomains: true,
    contractBuildFilePath: null,
};

function ApiHubTestNodeLauncher(options) {
    if (!options) {
        options = { ...defaultOptions };
    }

    options = getCompleteOptions(options, defaultOptions);
    logger.info("Using the following options for launcher", options);

    let { maxTries, rootFolder, storageFolder, port, serverConfig, domains } = options;

    this.launch = (callback) => {
        callback = $$.makeSaneCallback(callback);
        this.launchAsync()
            .then((result) => callback(undefined, result))
            .catch((error) => callback(error));
    };

    this.launchAsync = async () => {
        let apiHubPort = port;
        if (!apiHubPort) {
            while (maxTries > 0) {
                apiHubPort = getRandomPort();
                logger.info(`Generated random port ${apiHubPort}`);

                if (await isPortAvailableAsync(apiHubPort)) {
                    logger.info(`Port ${apiHubPort} is available`);
                    break;
                }

                maxTries--;
            }
        }

        const nodeUrl = `http://localhost:${apiHubPort}`;

        storeRequiredEnvironmentVariables(rootFolder, nodeUrl);

        await storeServerConfigAsync(rootFolder, serverConfig);
        await storeServerDomainConfigsAsync(rootFolder, domains);

        let validatorDID;
        let validators = [];

        const isBricksLedgerRequired = !!options.contractBuildFilePath;
        if (isBricksLedgerRequired) {
            validatorDID = await getValidatorDIDAsync(options);
            validators = getValidators(options, validatorDID, nodeUrl);
        }

        const bdns = getBDNSEntries(options, nodeUrl, validators);
        await storeDBNSAsync(rootFolder, bdns);

        if (isBricksLedgerRequired) {
            // update BDNS inside opendsu since it's cached at startup and the validatorDID construction triggers the opendsu load
            const bdnsApi = require("opendsu").loadApi("bdns");
            bdnsApi.setBDNSHosts(bdns);
        }

        try {
            let domainSeed;
            const { contractBuildFilePath, useWorker } = options;
            if (isBricksLedgerRequired) {
                const workerApiHubOptions = {
                    port: apiHubPort,
                    rootFolder,
                    contractBuildFilePath,
                };

                const workerResult = await createApiHubInstanceWorkerAsync(workerApiHubOptions);
                domainSeed = workerResult.domainSeed;

                await updateDomainConfigsWithContractConstitutionAsync(rootFolder, domains, domainSeed);

                // wait until the port is cleared by the worker
                let portUsageCheckRetries = 10;
                while (portUsageCheckRetries > 0) {
                    if (await isPortAvailableAsync(apiHubPort)) {
                        logger.info(`Port ${apiHubPort} is available again`);
                        break;
                    }

                    logger.info(
                        `Waiting until port ${apiHubPort} is cleared by the worker (${portUsageCheckRetries} retries left)...`
                    );
                    await sleepAsync(500);

                    portUsageCheckRetries--;
                }
            }

            const apiHubNode = useWorker
                ? await createApiHubInstanceWorkerAsync({ port: apiHubPort, rootFolder })
                : await createApiHubInstanceAsync(apiHubPort, rootFolder);

            let validatorDIDInstance;
            if (validatorDID) {
                validatorDIDInstance = await loadValidatorDIDInstanceAsync(validatorDID);
            }

            return {
                port: apiHubPort,
                node: apiHubNode,
                rootFolder,
                storageFolder,
                domainSeed,
                validatorDID,
                validatorURL: nodeUrl,
                validatorDIDInstance,
            };
        } catch (error) {
            logger.error(`Failed to start ApiHub on port ${apiHubPort}`, error);
            maxTries--;
            if (maxTries <= 0) {
                logger.error("Max ApiHub launch retries reached. Aborting launch...");
                throw error;
            }

            return this.launchAsync();
        }
    };
}

module.exports = ApiHubTestNodeLauncher;
