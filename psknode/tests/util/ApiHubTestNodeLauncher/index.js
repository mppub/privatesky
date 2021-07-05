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
    storageFolder: null,
    serverConfig: {},
    domains: null,
    bdns: null,
    validatorDID: null,
    validators: null,
    useWorker: false,
    bricksLedgerConfig: null,
    includeDefaultDomains: true,
};

function ApiHubTestNodeLauncher(options) {
    if (!options) {
        options = { ...defaultOptions };
    }

    options = getCompleteOptions(options, defaultOptions);
    logger.info("Using the following options for launcher", options);

    let { maxTries, storageFolder, port, serverConfig, domains } = options;

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

        storeRequiredEnvironmentVariables(storageFolder, nodeUrl);

        await storeServerConfigAsync(storageFolder, serverConfig);
        await storeServerDomainConfigsAsync(storageFolder, domains);

        let validatorDID = await getValidatorDIDAsync(options);
        const validators = getValidators(options, validatorDID, nodeUrl);

        const bdns = getBDNSEntries(options, nodeUrl, validators);
        await storeDBNSAsync(storageFolder, bdns);

        // update BDNS inside opendsu since it's cached at startup
        const bdnsApi = require("opendsu").loadApi("bdns");
        bdnsApi.setBDNSHosts(bdns);

        try {
            let domainSeed;
            const { contractBuildFilePath, useWorker } = options;
            if (contractBuildFilePath) {
                const workerApiHubOptions = {
                    port: apiHubPort,
                    storageFolder,
                    contractBuildFilePath,
                };

                const workerResult = await createApiHubInstanceWorkerAsync(workerApiHubOptions);
                domainSeed = workerResult.domainSeed;

                await updateDomainConfigsWithContractConstitutionAsync(storageFolder, domains, domainSeed);

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
                ? await createApiHubInstanceWorkerAsync({ port: apiHubPort, storageFolder })
                : await createApiHubInstanceAsync(apiHubPort, storageFolder);

            const validatorDIDInstance = await loadValidatorDIDInstanceAsync(validatorDID);

            return {
                port: apiHubPort,
                node: apiHubNode,
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
