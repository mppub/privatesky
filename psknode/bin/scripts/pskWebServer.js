const path = require("path");
require("../../core/utils/pingpongFork").enableLifeLine();
require(path.join(__dirname, '../../bundles/pskWebServer.js'));
require(path.join(__dirname, '../../bundles/edfsBar.js'));
require(path.join(__dirname, '../../bundles/consoleTools'));

const PskWebServer = require('psk-apihub');
const fs = require('fs');
if (!process.env.PSK_ROOT_INSTALATION_FOLDER) {
    process.env.PSK_ROOT_INSTALATION_FOLDER = path.resolve("." + __dirname + "/../..");
}
function startServer() {
    let sslConfig = undefined;
    let config = PskWebServer.getServerConfig();
    console.log('[PskWebServer] Using certificates from path', path.resolve(config.sslFolder));

    try {
        sslConfig = {
            cert: fs.readFileSync(path.join(config.sslFolder, 'server.cert')),
            key: fs.readFileSync(path.join(config.sslFolder, 'server.key'))
        };
    } catch (e) {
        console.log('[PskWebServer] No certificates found, PskWebServer will start using HTTP');
    }

    const listeningPort = Number.parseInt(config.port);
    const rootFolder = path.resolve(config.storage);

    const virtualMq = PskWebServer.createPskWebServer(listeningPort, rootFolder, sslConfig, (err) => {
        if (err) {
            console.error(err);
        }
    });
}

startServer();
