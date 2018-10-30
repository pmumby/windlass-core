const Web3 = require("web3")
const TruffleContract = require("truffle-contract")

class Chain {
    constructor(configObject,logger) {
        this.config = Object.assign(configObject)
        this.logger = logger
        this.web3Provider = null
        this.ready = false
        this.accountReady = false
        this.cachedAccount = ""
        this.latestBlock = 0
        this.pendingTX = []
        this.watchedObjects = []
        this.contracts = {}
        this.contractInstances = {}
        this.suspendMessages = false;
        this.log = this.log.bind(this)
        this.logSilent = this.logSilent.bind(this)
    }

    log(message, priority = "INFO", timeout = 3000) {
        this.logger.log("Blockchain", message, priority, timeout)
    }

    logSilent(message, priority = "INFO") {
        this.log(message,priority,0)
    }

    async init() {
        this.logSilent("Initializing Blockchain Connection...")
        await this.initWeb3()
        await this.initContracts()
        this.poll()
        this.ready = true
        this.logSilent("Blockchain Initialization Complete!")
    }

    async poll() {
        //Check for account changes:
        this.getAccount()
        //Check for new block:
        this.web3.eth.getBlockNumber(async (error, currentBlock) => {
            if (currentBlock > this.latestBlock) {
                this.web3.eth.getBlock(currentBlock, async (error, blockData) => {
                    this.latestBlock = currentBlock;
                    await this.newBlock(blockData);
                });
            }
        });
        window.setTimeout(this.poll.bind(this), this.config.pollingInterval);
    }

    async newBlock(blockData) {
        var blockNumber = blockData.number;
        this.logSilent("New Block Detected:" + blockNumber, "DEBUG")
        this.checkWatchedObjects(blockNumber);
        for (const tx of blockData.transactions) {
            await this.checkTX(tx);
        }
    }

    async checkWatchedObjects(blockNumber) {
        var blockEvents = await this.fetchBlockLogs(blockNumber);
        for (const idx in this.watchedObjects) {
            if (this.watchedObjects.hasOwnProperty(idx)) {
                var watch = this.watchedObjects[idx];
                var update = false;
                if (typeof watch.hooks === 'string' || watch.hooks instanceof String) {
                    update = this.handleHook(watch.hooks, blockEvents, watch.id);
                } else if ((watch.hooks !== undefined && watch.hooks !== null) && watch.hooks.constructor === Array) {
                    //We have a hooks array
                    for (const hookidx in watch.hooks) {
                        if (watch.hooks.hasOwnProperty(hookidx)) {
                            var hook = watch.hooks[hookidx];
                            if (this.handleHook(hook, blockEvents, watch.id, watch.callback)) {
                                update = true
                                break
                            }
                        }
                    }
                } else {
                    //No hooks provided, so always update on every block
                    update = true;
                }
                if (update) {
                    if (watch.callback instanceof Function) {
                        watch.callback(watch.id);
                    }
                }
            }
        }
    }

    handleHook(hookString, blockEvents, id, callback) {
        for (const idx in blockEvents) {
            if (blockEvents.hasOwnProperty(idx)) {
                let event = blockEvents[idx];
                this.logSilent("Checking Hook: [" + hookString + "]", "DEBUG")
                if (!hookString.includes(":") && event.FQN === hookString) {
                    return true;
                }
                if (hookString.includes(":")) {
                    let [hook_fqn, hook_id_field] = hookString.split(":")
                    if (hook_fqn === event.FQN) {
                        this.logSilent("Event FQN Matches", "DEBUG")
                        let id_val = event.args.hasOwnProperty(hook_id_field) ? +event.args[hook_id_field].valueOf() : null
                        if (id === "*") {
                            if (callback instanceof Function) {
                                callback(id_val);
                            }
                            return false
                        } else {
                            return id_val === id
                        }
                    }
                }
            }
        }
        return false;
    }

    watchObject(objectID, eventHooks, callback, deleteCallback) {
        var idVal = objectID === "*" ? objectID : +objectID
        var watch = { id: idVal, hooks: eventHooks, callback: callback, delete: deleteCallback };
        this.watchedObjects.push(watch);
        this.logSilent("Adding Watch:" + watch, "DEBUG")
    }

    stopWatch(objectID) {
        for (const watch in this.watchedObjects) {
            if (watch.id === objectID) {
                this.logSilent("Deleting Watch:" + watch, "DEBUG")
                //TODO: Delete and call deletion callback
            }
        }
    }

    watchTX(txData, callback) {
        this.logSilent("TX: " + txData.tx + " Pending...", "INFO")
        this.pendingTX[txData.tx] = callback;
    }

    async checkTX(txHash) {
        this.web3.eth.getTransactionReceipt(txHash, async (error, result) => {
            if (!error) {
                await this.handleTX(result);
            } else {
                this.log("TX:" + txHash + " ERROR: " + error, "ERROR", 5000)
            }
        });
    }

    async handleTX(txData) {
        var txHash = txData.transactionHash;
        var txLogs = await this.fetchTXLogs(txData);
        //Trigger callback if relevant
        if (txHash in this.pendingTX) {
            this.logSilent("Pending TX:" + txHash + " Completed!", "INFO");
            this.pendingTX[txHash](txData, txLogs);
            delete this.pendingTX[txHash];
        }
    }

    async fetchBlockLogs(blockNumber) {
        this.logSilent("Reading Block Event Logs for Block #" + blockNumber, "DEBUG")
        let contractInstanceEventsMapFunc = entry => {
            let contractName = entry[0]
            let contractInstance = entry[1]
            return [contractName, new Promise((resolveFunction, rejectFunction) => {
                contractInstance.allEvents({ fromBlock: blockNumber, toBlock: blockNumber }).get((error, logs) => {
                    if (!error) {
                        resolveFunction(logs);
                    } else {
                        rejectFunction(error);
                    }
                });
            })];
        }
        let eventEnrichmentMapFunc = async (entry) => {
            let contractName = entry[0]
            let eventsData = await entry[1]
            eventsData.map(event => {
                event.contractName = contractName
                event.FQN = contractName + "." + event.event
                return event
            })
            return eventsData
        }
        let eventAggregatorFunc = (acc, cur) => acc.concat(cur)
        let contractLogPromises = Object.entries(this.contractInstances).map(contractInstanceEventsMapFunc)
        let contractEnrichedLogEntries = contractLogPromises.map(eventEnrichmentMapFunc)
        let resolvedLogEntries = await Promise.all(contractEnrichedLogEntries)
        let aggregatedLogEntries = resolvedLogEntries.reduce(eventAggregatorFunc)
        return aggregatedLogEntries
    }

    async fetchTXLogs(txData) {
        var blockNumber = txData.blockNumber;
        var txHash = txData.transactionHash;
        this.logSilent("Fetching Transaction Logs for TX:" + txHash, "DEBUG")
        const blockEventLogs = await this.fetchBlockLogs(blockNumber);
        var txEventLogs = blockEventLogs.filter(event => event.transactionHash === txHash)
        return txEventLogs;
    }

    async initWeb3() {
        this.logSilent("Initializing Web3...");
        if (typeof window.ethereum !== 'undefined') {
            // Is the new EIP1102 window.ethereum injected provider present?
            this.web3Provider = ethereum
            await ethereum.enable();
            this.logSilent("Privacy Enabled Ethereum Browser Detected", "INFO");
        } else if (typeof window.web3 !== 'undefined') {
            // Is there is an injected web3 instance?
            this.web3Provider = window.web3.currentProvider;
            this.log("Legacy Web3 Browser Injection Detected! See Documentation for EIP1102 For assistance improving your privacy!", "WARN");
        } else {
            // If no injected web3 instance is detected, fallback to the TestRPC
            this.web3Provider = new Web3.providers.HttpProvider(this.config.fallbackProvider);
            this.log("No injection Detected! Falling back to direct RPC Provider!", "WARN");
        }
        this.web3 = new Web3(this.web3Provider);
    }

    getAccount() {
        var newAccountA = this.web3.eth.defaultAccount;
        var newAccountB = this.web3.eth.accounts[0];
        var newAccount = newAccountA || newAccountB
        var oldCache = this.cachedAccount;
        if (newAccount !== undefined) {
            this.cachedAccount = newAccount;
            this.accountReady = true;
            if (newAccount !== oldCache) {
                if (oldCache !== "" && oldCache !== undefined) {
                    this.detectedAccountChange()
                } else {
                    this.log("Initial Account Detected: " + this.cachedAccount)
                }
            }
            this.suspendMessages = false;
        } else {
            if (!this.suspendMessages) {
                this.log("Account Selection Pending... Please see your browser plugin (ie: metamask)", "WARN")
                this.suspendMessages = true;
            }
        }
        return this.cachedAccount;
    }

    detectedAccountChange() {
        this.log("New Account Selected: " + this.cachedAccount)
        if (typeof this.config.accountChangeCallback === "function") {
            this.config.accountChangeCallback(this.cachedAccount)
        }
    }

    async initContracts() {
        this.logSilent("Initializing Smart Contract Instances...");
        this.logSilent(this.config.contracts.length + " Contracts Found...");
        for (const contractData of this.config.contracts) {
            this.logSilent("...Initializing Contract: " + contractData.contractName);
            this.contracts[contractData.contractName] = TruffleContract(contractData);
            this.contracts[contractData.contractName].setProvider(this.web3Provider);
            this.contractInstances[contractData.contractName] = await this.contracts[contractData.contractName].deployed();
        };
    }
}

module.exports = Chain