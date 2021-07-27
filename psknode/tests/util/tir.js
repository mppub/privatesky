/**
 * Test Infrastructure Runner
 *
 */
const path = require("path");
process.env.PSK_ROOT_INSTALATION_FOLDER = path.join(__dirname, "../../../");

require(path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskWebServer.js")));

const os = require("os");
const fs = require("fs");
const pskPath = require("swarmutils").path;

const { getRandomPort, createKey, createConstitution, whenAllFinished, buildConstitution, getRandomAvailablePortAsync } = require("./tir-utils");
const ApiHubTestNodeLauncher = require("./ApiHubTestNodeLauncher");

const Tir = function () {
    const pingPongFork = require("../../core/utils/pingpongFork");
    const openDSU = require("opendsu");

    const domainConfigs = {};
    const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), "psk_"));

    let testerNode = null;
    let virtualMQNode = null;
    let virtualMQPort = null;
    let zeroMQPort = null;

    /**
     * Adds a domain to the configuration, in a fluent way.
     * Does not launch anything, just stores the configuration.
     *
     * @param {string} domainName The name of the domain
     * @param {array} agents The agents to be inserted
     * @param {string} constitutionSourceFolder
     * @param bundlesSourceFolder
     * @returns SwarmDescriber
     */
    this.addDomain = function (domainName, agents, constitutionSourceFolder, bundlesSourceFolder) {
        let workspace = path.join(rootFolder, "nodes", createKey(domainName));
        domainConfigs[domainName] = {
            name: domainName,
            agents,
            /*constitution: {},*/
            constitutionSourceFolder,
            bundlesSourceFolder: bundlesSourceFolder || path.resolve(path.join(__dirname, "../../bundles")),
            workspace: workspace,
            blockchain: path.join(workspace, "conf"),
        };
    };

    /**
     * Launches all the configured domains.
     *
     * @param {number|function} tearDownAfter The number of milliseconds the TIR will tear down, even if the test fails. If missing, you must call tearDown
     * @param {function} callable The callback
     */
    this.launch = (tearDownAfter, callable) => {
        if (callable === undefined && tearDownAfter.call) {
            callable = tearDownAfter;
            tearDownAfter = null;
        }

        if (testerNode !== null) {
            throw new Error("Test node already launched!");
        }

        if (virtualMQNode !== null) {
            throw new Error("VirtualMQ node already launched!");
        }

        console.info("[TIR] setting working folder root", rootFolder);

        const assert = require("double-check").assert;
        assert.addCleaningFunction(() => {
            this.tearDown(0);
        });

        launchVirtualMQNode(100, rootFolder, (err, vmqPort) => {
            if (err) {
                throw err;
            }

            virtualMQPort = vmqPort;
            $$.BDNS.addConfig("default", {
                endpoints: [
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: "brickStorage",
                    },
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: "anchorService",
                    },
                ],
            });

            if (Object.keys(domainConfigs).length === 0) {
                // no domain added
                prepareTeardownTimeout();
                callable(undefined, virtualMQPort);

                return;
            }

            launchLocalMonitor(callCallbackWhenAllDomainsStarted);

            fs.mkdirSync(path.join(rootFolder, "nodes"), { recursive: true });

            const fakeDomainFile = path.join(rootFolder, "domain.js");
            fs.writeFileSync(fakeDomainFile, "console.log('domain.js loaded.')");

            const defaultConstitutionBundlesPath = [
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskruntime.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/edfsBar.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/blockchain.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskWebServer.js")),
                fakeDomainFile,
            ];

            EDFS.createDSU("Bar", (err, launcherBar) => {
                if (err) {
                    throw err;
                }

                launcherBar.load((err) => {
                    if (err) {
                        throw err;
                    }
                    launcherBar.addFiles(defaultConstitutionBundlesPath, openDSU.constants.CONSTITUTION_FOLDER, (err) => {
                        if (err) {
                            throw err;
                        }

                        launcherBar.getKeySSIAsString((err, launcherKeySSI) => {
                            if (err) {
                                throw err;
                            }
                            const dossier = require("dossier");

                            dossier.load(launcherKeySSI, "TIR_AGENT_IDENTITY", (err, csbHandler) => {
                                if (err) {
                                    throw err;
                                }

                                global.currentHandler = csbHandler;
                                whenAllFinished(Object.values(domainConfigs), this.buildDomainConfiguration, (err) => {
                                    if (err) {
                                        throw err;
                                    }

                                    const seed = launcherKeySSI;

                                    testerNode = pingPongFork.fork(
                                        path.resolve(path.join(__dirname, "../../core/launcher.js")),
                                        [seed, rootFolder],
                                        {
                                            stdio: "inherit",
                                            env: {
                                                PSK_PUBLISH_LOGS_ADDR: `tcp://127.0.0.1:${zeroMQPort}`,
                                            },
                                        }
                                    );

                                    initializeSwarmEngine(virtualMQPort);
                                    prepareTeardownTimeout();
                                });
                            });
                        });
                    });
                });
            });
        });

        let domainsLeftToStart = Object.keys(domainConfigs).length;

        function callCallbackWhenAllDomainsStarted() {
            domainsLeftToStart -= 1;

            if (domainsLeftToStart === 0) {
                callable(undefined, virtualMQPort);
            }
        }

        let prepareTeardownTimeout = () => {
            setTimeout(() => {
                if (tearDownAfter !== null) {
                    setTimeout(() => this.tearDown(1), tearDownAfter);
                }
            }, 1000);
        };
    };

    function launchVirtualMQNode(maxTries, rootFolder, callback) {
        let config = {};
        if (typeof maxTries === "object") {
            config = maxTries;
            callback = rootFolder;
        } else {
            if (typeof rootFolder === "function") {
                callback = rootFolder;
                rootFolder = maxTries;
                maxTries = 100;
            }

            if (typeof maxTries === "function") {
                callback = maxTries;
                rootFolder = rootFolder;
                maxTries = 100;
            }

            config = { maxTries, rootFolder };
        }

        const apiHubTestNodeLauncher = new ApiHubTestNodeLauncher(config);
        apiHubTestNodeLauncher.launch((err, result) => {
            if (err) {
                return callback(err);
            }
            const { port, node } = result;
            virtualMQNode = node;
            callback(null, port);
        });
    }

    this.launchVirtualMQNode = launchVirtualMQNode;
    this.launchApiHubTestNode = launchVirtualMQNode;

    function launchLocalMonitor(maxTries, onBootMessage) {
        if (typeof maxTries === "function") {
            onBootMessage = maxTries;
            maxTries = 100;
        }

        if (typeof maxTries !== "number" || maxTries < 0) {
            maxTries = 100;
        }

        const zeromqName = "zeromq";
        const zmq = require(zeromqName);
        const zmqReceiver = zmq.createSocket("sub");

        zmqReceiver.subscribe("events.status.domains.boot");
        zmqReceiver.on("message", onBootMessage);

        let portFound = false;

        while (!portFound && maxTries > 0) {
            zeroMQPort = getRandomPort();
            maxTries -= 1;
            try {
                zmqReceiver.bindSync(`tcp://127.0.0.1:${zeroMQPort}`);
                portFound = true;
            } catch (e) {
                console.log(e);
            } // port not found yet
        }

        if (!portFound) {
            throw new Error("Could not find a free port for zeromq");
        }

        console.log("[TIR] zeroMQ bound to address", `tcp://127.0.0.1:${zeroMQPort}`);
    }

    function initializeSwarmEngine(port) {
        const se = require("swarm-engine");
        try {
            se.initialise();
        } catch (err) {
            //
        }

        const powerCordToDomain = new se.SmartRemoteChannelPowerCord([`http://127.0.0.1:${port}/`]);
        $$.swarmEngine.plug("*", powerCordToDomain);
    }

    /**
     * Builds the config for a node.
     *
     * @param {object} domainConfig The domain configuration stored by addDomain
     * @param callback
     */
    this.buildDomainConfiguration = (domainConfig, callback) => {
        console.info("[TIR] domain " + domainConfig.name + " in workspace", domainConfig.workspace);

        fs.mkdirSync(domainConfig.workspace, { recursive: true });

        getConstitutionSeed((err, constitutionSeed) => {
            if (err) {
                return callback(err);
            }

            const zeroMQPort = getRandomPort();
            const communicationInterfaces = {
                system: {
                    virtualMQ: `http://127.0.0.1:${virtualMQPort}`,
                    //zeroMQ: `tcp://127.0.0.1:${zeroMQPort}`
                },
            };

            global.currentHandler
                .startTransaction("Domain", "add", domainConfig.name, "system", domainConfig.workspace, constitutionSeed)
                .onReturn((err) => {
                    if (err) {
                        return callback(err);
                    }

                    if (domainConfig.agents && Array.isArray(domainConfig.agents) && domainConfig.agents.length > 0) {
                        const dossier = require("dossier");
                        dossier.load(constitutionSeed, "TIR_AGENT_IDENTITY", (err, csbHandler) => {
                            if (err) {
                                return callback(err);
                            }

                            let transactionsLeft = domainConfig.agents.length + 1;

                            console.info("[TIR] domain " + domainConfig.name + " starting defining agents...");

                            domainConfig.agents.forEach((agentName) => {
                                console.info("[TIR] domain " + domainConfig.name + " agent", agentName);
                                csbHandler.startTransaction("Agents", "add", agentName, "public_key").onReturn(maybeCallCallback);
                            });

                            csbHandler
                                .startTransaction("DomainConfigTransaction", "add", domainConfig.name, communicationInterfaces)
                                .onReturn(maybeCallCallback);

                            function maybeCallCallback(err) {
                                if (err) {
                                    transactionsLeft = -1;
                                    return callback(err);
                                }

                                transactionsLeft -= 1;

                                if (transactionsLeft === 0) {
                                    callback();
                                }
                            }
                        });
                    } else {
                        callback();
                    }
                });
        });

        function getConstitutionSeed(callback) {
            const constitutionBundles = [domainConfig.bundlesSourceFolder];
            //console.log("constitutionBundles", constitutionBundles);

            deployConstitutionCSB(constitutionBundles, domainConfig.name, (err, archive) => {
                if (err) {
                    return callback(err);
                }

                buildConstitution(domainConfig.constitutionSourceFolder, archive, (err) => {
                    if (err) {
                        return callback(err);
                    }
                    archive.getKeySSIAsString((err, keySSI) => {
                        callback(err, keySSI);
                    });
                });
            });
        }

        function deployConstitutionCSB(constitutionPaths, domainName, callback) {
            if (typeof domainName === "function" && typeof callback === "undefined") {
                callback = domainName;
                domainName = "";
            }

            EDFS.createDSU("Bar", (err, constitutionArchive) => {
                if (err) {
                    return callback(err);
                }
                const lastHandler = (err) => {
                    if (err) {
                        return callback(err);
                    }

                    callback(undefined, constitutionArchive);
                };

                const __addNext = (index = 0) => {
                    constitutionArchive.load((err) => {
                        if (err) {
                            return lastHandler(err);
                        }

                        if (index >= constitutionPaths.length) {
                            if (domainName !== "") {
                                constitutionArchive.writeFile(openDSU.constants.DOMAIN_IDENTITY_FILE, domainName, lastHandler);
                            } else {
                                lastHandler();
                            }

                            return;
                        }

                        const currentPath = constitutionPaths[index];
                        constitutionArchive.addFolder(
                            currentPath,
                            pskPath.join(openDSU.constants.CODE_FOLDER, openDSU.constants.CONSTITUTION_FOLDER),
                            (err) => {
                                if (err) {
                                    return callback(err);
                                }

                                __addNext(index + 1);
                            }
                        );
                    });
                };
                __addNext();
            });
        }

        function getConstitutionFile(callback) {
            createConstitution(
                domainConfig.workspace,
                domainConfig.constitution,
                undefined,
                domainConfig.constitutionSourceFolder,
                callback
            );
        }
    };

    this.getDomainConfig = (domainName) => {
        return domainConfigs[domainName];
    };

    /**
     * Tears down all the nodes
     *
     * @param exitStatus The exit status, to exit the process.
     */
    this.tearDown = (exitStatus) => {
        console.info("[TIR] Tearing down...");
        if (testerNode) {
            console.info("[TIR] Killing node", testerNode.pid);
            try {
                process.kill(testerNode.pid);
            } catch (e) {
                console.info("[TIR] Node already killed", testerNode.pid);
            }
            testerNode = null;
        }

        if (virtualMQNode) {
            console.log("[TIR] Killing VirtualMQ node", virtualMQNode.pid);
            try {
                process.kill(virtualMQNode.pid);
            } catch (e) {
                console.info("[TIR] VirtualMQ node already killed", virtualMQNode.pid);
            }
        }

        setTimeout(() => {
            try {
                console.info("[TIR] Removing temporary folder", rootFolder);
                fs.rmdirSync(rootFolder, { recursive: true });
                console.info("[TIR] Temporary folder removed", rootFolder);
            } catch (e) {
                //just avoid to display error on console
            }

            /*if (exitStatus !== undefined) {
                process.exit(exitStatus);
            }*/
        }, 100);
    };

    this.buildConstitution = buildConstitution;

    this.launchConfigurableApiHubTestNode = (config, callback) => {
        callback = $$.makeSaneCallback(callback);
        this.launchConfigurableApiHubTestNodeAsync(config)
            .then((result) => callback(undefined, result))
            .catch((error) => callback(error));
    };

    this.launchConfigurableApiHubTestNodeAsync = async (config) => {
        if (config && typeof config !== "object") {
            throw new Error("Invalid config specified");
        }
        config = config || {};

        const apiHubTestNodeLauncher = new ApiHubTestNodeLauncher(config);
        const { node, ...rest } = await apiHubTestNodeLauncher.launchAsync();
        virtualMQNode = node;
        return rest;
    };

    this.getRandomAvailablePortAsync = getRandomAvailablePortAsync;

    this.launchApiHubTestNodeWithContract = (contractBuildFilePath, domain, config, callback) => {
        if (typeof config === "function") {
            callback = config;
            config = null;
        }
        if (typeof domain === "function") {
            callback = domain;
            config = null;
            domain = null;
        }
        if (typeof contractBuildFilePath === "function") {
            callback = contractBuildFilePath;
            config = null;
            domain = null;
            contractBuildFilePath = null;
        }
        callback = $$.makeSaneCallback(callback);
        this.launchApiHubTestNodeWithContractAsync(domain, config, callback)
            .then((result) => callback(undefined, result))
            .catch((error) => callback(error));
    };

    this.launchApiHubTestNodeWithContractAsync = async (contractBuildFilePath, domain, config) => {
        if (!contractBuildFilePath || typeof contractBuildFilePath !== "string") {
            throw new Error("Missing or invalid contractBuildFilePath");
        }
        if (typeof domain === "object") {
            config = domain;
            domain = null;
        }
        if (!config) {
            config = {};
        }
        if (!domain && !config.domains) {
            domain = "contract";
            config = { ...config, domains: [domain] };
        }

        config = { ...config, contractBuildFilePath };
        const apiHubTestNodeLauncher = new ApiHubTestNodeLauncher(config);
        const { node, ...rest } = await apiHubTestNodeLauncher.launchAsync();
        virtualMQNode = node;

        // return the updated domainConfig for further usage inside integration tests
        const domainConfig =
            config.domains && config.domains[0] && typeof config.domains[0] === "object" ? config.domains[0].config : {};
        domainConfig.contracts = domainConfig.contracts || {};
        domainConfig.contracts.constitution = rest.domainSeed;

        const result = {
            ...rest,
            // domainConfig for contract domain
            domainConfig,
        };

        return result;
    };
};

module.exports = new Tir();
