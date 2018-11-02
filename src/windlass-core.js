const defaultConfig = require("./../conf/default-config.json")
const Logger = require("./logger.js")
const Chain = require("./chain.js")

class Windlass {

    constructor(configObject) {
        this.config = Object.assign(defaultConfig, configObject)
        this.logger = new Logger(this.config.logger)
        this.chain = new Chain(this.config.chain, this.logger)
        this.models = {}
        this.dataCache = {}
        this.log = this.log.bind(this)
        this.logSilent = this.logSilent.bind(this)
        this.logContract = this.logContract.bind(this)
    }

    log(message, priority = "INFO", timeout = 3000) {
        this.logger.log(this.config.systemName, message, priority, timeout)
    }

    logSilent(message, priority = "INFO") {
        this.log(message,priority,0)
    }

    logContract(contract, message, priority = "INFO", timeout = 3000) {
        this.logger.log(contract, message, priority, timeout)
    }

    async init() {
        this.logSilent("Initializing Windlass Framework")
        await this.chain.init()
        this.logger.init()
        this.initModels()
        this.logSilent("Windlass Initialization Complete!")
    }

    initModels() {
        this.logSilent("Initializing Object Models...")
        this.logSilent(Object.keys(this.config.datamodel).length + " Models Found...")
        for (const modelName in this.config.datamodel) {
            let modelData = this.config.datamodel[modelName]
            this.logSilent("...Initializing Model: " + modelName)
            this.dataCache[modelName] = new Map()
            let newModel = Object.assign(
                this.generateObjectMethods(modelName,modelData),
                {config:modelData}
                //TODO: Possibly other objects to compose for model
            )
            this.models[modelName] = newModel
            this.setupNewObjectHooks(modelName)
            this.enumerateObjects(modelName)
        };
    }

    dataUpdated() {
        this.logSilent("Cache Updated!", "DEBUG")
        if (typeof this.config.updateCallback === "function") {
            this.config.updateCallback(this.dataCache)
        }
    }

    async fetchObjectData(modelName, indexValue) {
        let modelData = this.models[modelName].config
        let modelContract = modelData.primaryContract
        let core = this.chain.contractInstances[modelContract]
        let obj = new Map()
        for (const propertyName in modelData.properties) {
            let property = modelData.properties[propertyName]
            if (propertyName === modelData.primaryKey) {
                obj.set(propertyName, indexValue)
            } else {
                let attribRawValue = await core[property.getter].call(indexValue)
                if (property.type === "integer") {
                    obj.set(propertyName, +(attribRawValue.valueOf()))
                } else {
                    obj.set(propertyName, attribRawValue)
                }
                //TODO: Definitely need to flesh this out to handle other types, etc...
            }
        }
        return obj
    }

    watchObject(modelName, indexValue) {
        //TODO: Do this with ws API if possible, for true push (reduce load on JS for constantly polling on new block)
        let modelData = this.models[modelName].config
        let hooks = [];
        for (const contractName in modelData.events) {
            let contract = modelData.events[contractName]
            for (const eventName in contract) {
                let event = contract[eventName]
                if (event.indicatesUpdate) {
                    //TODO: Refactor this to not be a string, make it an object
                    hooks.push(contractName + "." + eventName + ":" + event.indexField)
                }
            }
        }
        if (hooks.length > 0) {
            let callback = (objectID) => this.refreshObject(modelName, objectID)
            this.chain.watchObject(indexValue, hooks, callback)
            callback(indexValue)
        }
    }

    async refreshObject(modelName, indexValue) {
        this.dataCache[modelName].set(indexValue, await this.fetchObjectData(modelName, indexValue))
        this.dataUpdated()
    }

    async countObjects(modelName) {
        //TODO: Handle additional enumerators
        let modelData = this.models[modelName].config
        let modelContract = modelData.primaryContract
        let defaultEnumerator = modelData.enumerators[modelData.defaultEnumerator]
        let core = this.chain.contractInstances[modelContract]
        let objCount = await core[defaultEnumerator.method].call.apply(this, defaultEnumerator.parameters)
        return objCount
    }

    async enumerateObjects(modelName, limit=0, offset=0, filters=[]) {
        //TODO: Additional Enumerators & Handle Filters
        let modelData = this.models[modelName].config
        this.logContract(modelName,"Enumerating Objects...","DEBUG",0)
        let modelContract = modelData.primaryContract
        let defaultEnumerator = modelData.enumerators[modelData.defaultEnumerator]
        let core = this.chain.contractInstances[modelContract]
        let objCount = await core[defaultEnumerator.method].call.apply(this, defaultEnumerator.parameters)
        for (let i = offset; i < offset+limit && i < objCount; i++) {
            this.watchObject(modelName, i);
        }
        this.logContract(modelName,"Enumeration Complete!","DEBUG",0)
    }

    setupNewObjectHooks(modelName) {
        let modelData = this.models[modelName].config
        let hooks = []
        for (const contractName in modelData.events) {
            let contract = modelData.events[contractName]
            for (const eventName in contract) {
                let event = contract[eventName]
                if (event.indicatesCreation) {
                    //TODO: Refactor this to not be a string, make it an object
                    hooks.push(contractName + "." + eventName + ":" + event.indexField)
                }
            }
        }
        if (hooks.length > 0) {
            let callback = (objectID) => this.watchObject(modelName, objectID)
            this.chain.watchObject("*", hooks, callback)
        }
    }

    generateObjectMethods(modelName,modelData) {
        let modelContract = modelData.primaryContract
        let core = this.chain.contractInstances[modelContract]
        let methods = {}
        //Generate Setter Function Wrappers
        for (const propertyName in modelData.properties) {
            let property = modelData.properties[propertyName]
            if (property.hasOwnProperty("setter")) {
                let fSetter = async function(index, value) {
                    let funcString = "Update to " + modelName + " ID:" + index + " " + property.title + " To Value: [" + value + "]"
                    let logStringReq = "Requesting " + funcString + "..."
                    let logStringSuccess = funcString + " was Successful!"
                    this.logContract(modelContract, logStringReq)
                    let txCallback = (txData, txLogs) => {
                        this.logContract(modelContract, logStringSuccess)
                    }
                    let txResult = await core[property.setter](index, value, { from: this.chain.getAccount() })
                    this.chain.watchTX(txResult, txCallback)
                    return txResult
                }
                methods[property.setter] = fSetter.bind(this)
            }
        }
        //Generate Action Function Wrappers
        for (const actionName in modelData.actions) {
            let action = modelData.actions[actionName]
            let fAction = async function(index) {
                //TODO: Handle extra params!
                let funcString = action.title+" on "+modelName+" ID:"+index
                let logStringReq = "Requesting " + funcString + "..."
                let logStringSuccess = funcString + " was Successful!"
                this.logContract(modelContract, logStringReq)
                let txCallback = (txData, txLogs) => {
                    this.logContract(modelContract, logStringSuccess)
                }
                let txResult = await core[action.method](index, value, { from: this.chain.getAccount() })
                this.chain.watchTX(txResult, txCallback)
                return txResult
            }
            methods[actionName] = fAction.bind(this)
        }
        //Generate Constructor Function Wrapper
        let fConstructor = async function (...args) {
            let funcString = modelData.constructor.title
            let logStringReq = "Requesting " + funcString + "..."
            let logStringSuccess = funcString + " was Successful!"
            this.logContract(modelContract, logStringReq)
            let txCallback = (txData, txLogs) => {
                this.logContract(modelContract, logStringSuccess)
            }
            //TODO: Review, and more robust handling of this. Validation, etc. Based on model.
            let paramArray = args.concat([{ from: this.chain.getAccount() }])
            let txResult = await core[modelData.constructor.method].apply(this,paramArray)
            this.chain.watchTX(txResult, txCallback)
            return txResult
        }
        methods.new = fConstructor.bind(this)
        return methods
    }


}

module.exports = Windlass