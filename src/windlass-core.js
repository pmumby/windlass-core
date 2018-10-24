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
        this.logContract = this.logContract.bind(this)
    }

    log(message, priority = "INFO", timeout = 3000) {
        this.logger.log(this.config.systemName, message, priority, timeout)
    }

    logContract(contract, message, priority = "INFO", timeout = 3000) {
        this.logger.log(contract, message, priority, timeout)
    }

    async init() {
        this.log("Initializing Windlass Framework")
        await this.chain.init()
        this.logger.init()
        this.initModels()
        this.log("Windlass Initialization Complete!")
    }

    initModels() {
        this.log("Initializing Object Models...")
        this.log(this.config.models.length + " Models Found...")
        for (const modelData of this.config.models) {
            this.log("...Initializing Model: " + modelData.name)
            this.dataCache[modelData.name] = new Map()
            let newModel = Object.assign(
                this.buildObjectMethods(modelData),
                {config:modelData}
                //TODO: Possibly other objects to compose for model
            )
            this.models[modelData.name] = newModel
        };
    }

    dataUpdated() {
        this.log("Cache Updated!", "DEBUG")
        if (typeof this.config.updateCallback === "function") {
            this.config.updateCallback(this.dataCache)
        }
    }

    async fetchObjectData(modelName, indexValue) {
        let modelData = this.models[modelName].config
        let modelContract = modelData.contract
        let core = this.chain.contractInstances[modelContract]
        let obj = new Map()
        for (const attribute of modelData.attributes) {
            if (attribute.type == "index") {
                obj.set(attribute.name, indexValue)
            } else {
                let attribRawValue = await core[attribute.getter].call(indexValue)
                if (attribute.type == "number") {
                    obj.set(attribute.name, +(attribRawValue.valueOf()))
                } else {
                    obj.set(attribute.name, attribRawValue)
                }
                //TODO: Likely need to handle other cases here...
            }
        }
        return obj
    }

    watchObject(modelName, indexValue) {
        let modelData = this.models[modelName].config
        let hooks = [];
        for (const event of modelData.events) {
            if (event.indicatesUpdate) {
                hooks.push(event.contract + "." + event.name + ":" + event.indexField)
            }
        }
        if (hooks.length > 0) {
            let callback = (objectID) => this.updateObject(modelName, objectID)
            this.chain.watchObject(indexValue, hooks, callback)
            callback(indexValue)
        }
    }

    async updateObject(modelName, indexValue) {
        let modelData = this.models[modelName].config
        this.dataCache[modelData.name].set(indexValue, await this.fetchObjectData(modelName, indexValue))
        this.dataUpdated()
    }

    async enumerateObjects(modelName) {
        let modelData = this.models[modelName].config
        this.logContract(modelData.name,"Enumerating Objects...")
        let modelContract = modelData.contract
        let core = this.chain.contractInstances[modelContract]
        let objCount = await core[modelData.enumerator.method].call.apply(this, modelData.enumerator.extraParams)
        for (let i = 0; i < objCount; i++) {
            this.watchObject(modelName, i);
        }
        this.logContract(modelData.name,"Enumeration Complete!")
    }

    setupNewObjectHooks(modelData) {
        for (const event of modelData.events) {
            if (event.indicatesCreation) {
                hooks.push(event.contract + "." + event.name + ":" + event.indexField)
            }
        }
        if (hooks.length > 0) {
            let callback = (objectID) => this.watchObject(modelName, objectID)
            this.chain.watchObject("*", hooks, callback)
        }
    }

    buildObjectMethods(modelData) {
        let modelContract = modelData.contract
        let core = this.chain.contractInstances[modelContract]
        let methods = {}
        //Generate Setter Function Wrappers
        for (const attribute of modelData.attributes) {
            if (attribute.hasOwnProperty("setter")) {
                let fSetter = async function(index, value) {
                    let funcString = "Update to " + modelData.name + " ID:" + index + " " + attribute.friendlyName + " To Value: [" + value + "]"
                    let logStringReq = "Requesting " + funcString + "..."
                    let logStringSuccess = funcString + " was Successful!"
                    this.logContract(modelContract, logStringReq)
                    let txCallback = (txData, txLogs) => {
                        this.logContract(modelContract, logStringSuccess)
                    }
                    let txResult = await core[attribute.setter](index, value, { from: this.chain.getAccount() })
                    this.chain.watchTX(txResult, txCallback)
                    return txResult
                }
                methods[attribute.setter] = fSetter.bind(this)
            }
        }
        //Generate Action Function Wrappers
        for (const action of modelData.actions) {
            let fAction = async function(index) {
                //TODO: Handle extra params!
                let funcString = action.friendlyName+" on "+modelData.name+" ID:"+index
                let logStringReq = "Requesting " + funcString + "..."
                let logStringSuccess = funcString + " was Successful!"
                this.logContract(modelContract, logStringReq)
                let txCallback = (txData, txLogs) => {
                    this.logContract(modelContract, logStringSuccess)
                }
                let txResult = await core[attribute.setter](index, value, { from: this.chain.getAccount() })
                this.chain.watchTX(txResult, txCallback)
                return txResult
            }
            methods[action.name] = fAction.bind(this)
        }
        //Generate Constructor Function Wrapper
        let fConstructor = async function (...args) {
            let funcString = modelData.constructor.friendlyName
            let logStringReq = "Requesting " + funcString + "..."
            let logStringSuccess = funcString + " was Successful!"
            this.logContract(modelContract, logStringReq)
            let txCallback = (txData, txLogs) => {
                this.logContract(modelContract, logStringSuccess)
            }
            let paramArray = args.concat([{ from: this.chain.getAccount() }])
            //let paramArray = Array.prototype.concat.call(arguments,[{ from: this.chain.getAccount() }])
            console.log(paramArray)
            let txResult = await core[modelData.constructor.method].apply(this,paramArray)
            this.chain.watchTX(txResult, txCallback)
            return txResult
        }
        methods.new = fConstructor.bind(this)
        return methods
    }


}

module.exports = Windlass