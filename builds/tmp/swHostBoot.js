const or = require('overwrite-require');
or.enableForEnvironment(or.constants.SERVICE_WORKER_ENVIRONMENT_TYPE);
$$.log = $$.err = $$.fixMe = console.log;
require("./swHostBoot_intermediar");
