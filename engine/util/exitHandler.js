const events = ["exit", "SIGINT", "SIGUSR1", "SIGUSR2", "uncaughtException", "SIGTERM"];

module.exports = function manageShutdownProcess(childrenList){

    function handler(){
        console.log("Handling exit event on", process.pid);
        var childrenNames = Object.keys(childrenList);
        for(let j=0; j<childrenNames.length; j++){
            var child = childrenList[childrenNames[j]];
            console.log(`[${process.pid}]`, "Sending kill signal to PID:", child.pid);
            process.kill(child.pid);
        }

        if(childrenNames.length>0){
            process.exit(0);
        }
    }

    process.stdin.resume();
    for(let i=0; i<events.length; i++){
        var eventType = events[i];
        process.on(eventType, handler);
    }
    console.log("Exit handler setup!", `[${process.pid}]`);
};