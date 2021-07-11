require("../../../../psknode/bundles/testsRuntime");

const dc = require("double-check");
dc.assert.begin("worker", () => {}, 300000); // required in order for the process to not get killed by dc after 2 seconds

const fs = require("fs");
const path = require("path");
const { workerData } = require("worker_threads");
const Logger = require("../Logger");
const { runOctopusScriptAsync } = require("./launcher-utils");

const logger = new Logger("[ApiHubTestNodeLauncherWorkerBoot]");

async function buildAndCreateConstractDomain() {
    logger.info("Building and creating contract domain...");
    const { rootFolder, contractBuildFilePath } = workerData;
    const contractSeedPath = path.join(rootFolder, ".contract-seed");
    const domainSeedPath = path.join(rootFolder, ".domain-seed");

    // build contract DSU type
    await runOctopusScriptAsync("buildDossier", [`--seed=${contractSeedPath}`, contractBuildFilePath]);
    const contractSeed = fs.readFileSync(contractSeedPath, { encoding: "utf8" });

    // create DSU for contract
    await runOctopusScriptAsync("createDomain", [`--dsu-type-ssi=${contractSeedPath}`, `--seed=${domainSeedPath}`]);
    const domainSeed = fs.readFileSync(domainSeedPath, { encoding: "utf8" });
    return domainSeed;
}

async function boot() {
    logger.info("Booting...", workerData);

    const { parentPort } = require("worker_threads");

    try {
        const { port, rootFolder, contractBuildFilePath } = workerData;
        const pskApiHub = require("apihub");

        let apiHubInstance;
        const apiHubLoadedPromise = new Promise((resolve, reject) => {
            const callback = (error, result) => {
                if (error) {
                    return reject(error);
                }
                resolve(result);
            };
            apiHubInstance = pskApiHub.createInstance(port, rootFolder, callback);
        });

        const apiHubResult = await apiHubLoadedPromise;

        if (contractBuildFilePath) {
            const domainSeed = await buildAndCreateConstractDomain();
            parentPort.postMessage({ domainSeed });
            apiHubInstance.close();
            return;
        }

        parentPort.postMessage(apiHubResult);
    } catch (error) {
        logger.error("Boot error", error);
    }

    process.on("uncaughtException", (error) => {
        logger.error("uncaughtException inside node worker", error);
        setTimeout(() => process.exit(1), 100);
    });
}

boot();

module.exports = boot;
