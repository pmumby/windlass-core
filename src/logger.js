class Logger {
    constructor(configObject) {
        this.config = Object.assign(defaultConfig, configObject)
        this.logEvents = []
    }

    init() {
        this.log("Logger","Initializing Logger...")
    }

    logEvent(source, message, priority, timeout) {
        const newEvent = {
            source: source,
            priority: priority,
            message: message,
            timeout: timeout,
            timestamp: new Date()
        }
        this.logEvents.push(newEvent)
        if(this.config.logToConsole){
            let timeStampString = newEvent.timestamp.toISOString()
            let eventString = timeStampString+": ["+newEvent.source+"|"+newEvent.priority+"] - "+newEvent.message
            console.log(eventString)
        }
    }

    log(source, message, priority = "INFO", timeout = 3000) {
        let logLevelInt = this.config.logPriorities[this.config.logLevel] || -1000000
        let messagePriorityInt = this.config.logPriorities[priority.toUpperCase()] || -1000000
        if (messagePriorityInt >= logLevelInt) {
            this.logEvent(source,message,priority,timeout)
            if (typeof this.config.callback === "function") {
                this.config.callback(this.logEvents)
            }
        }
    }    
}

module.exports = Logger