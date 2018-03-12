const debug = require('../util/debug').here(__filename);
const { join } = require('path');
const url = require('url');
const express = require('express');
const GlobalConfig = require('../util/global-config');
const SSLCertStore = require('../util/ssl-cert-store');
const optionsValidator = require('../util/options-validator');
const middlewares = {
    originSubstitution: require('./middlewares/OriginSubstitution'),
    devProxy: require('./middlewares/DevProxy'),
    staticRootRoute: require('./middlewares/StaticRootRoute')
};
const { lookup } = require('../util/promisified/dns');
const { find: findPort } = require('../util/promisified/openport');
const runAsRoot = require('../util/run-as-root');
class DevServer {
    static validateConfig = optionsValidator('DevServer', {
        id: 'string',
        publicPath: 'string',
        backendDomain: 'string',
        'paths.output': 'string',
        'paths.assets': 'string',
        serviceWorkerFileName: 'string'
    });
    static hostnamesById = new GlobalConfig({
        prefix: 'devhostname-byid',
        key: x => x
    });
    static portsByHostname = new GlobalConfig({
        prefix: 'devport-byhostname',
        key: x => x
    });
    static async setLoopback(hostname) {
        debug(`checking if ${hostname} is loopback`);
        let ip;
        try {
            ip = await lookup(hostname);
        } catch (e) {
            if (e.code !== 'ENOTFOUND') {
                throw Error(
                    debug.errorMsg(
                        `Error trying to check that ${hostname} is loopback: ${
                            e.message
                        }`
                    )
                );
            }
        }
        if (ip && (ip.address === '127.0.0.1' || ip.address === '::1')) {
            debug(`${hostname} already resolves to ${ip.address}!`);
        } else {
            debug(
                `setting ${hostname} loopback in /etc/hosts, may require password...`
            );
            return runAsRoot(
                /* istanbul ignore next: never runs in process */
                d => require('hostile').set('127.0.0.1', d),
                hostname
            );
        }
    }
    static async findFreePort() {
        const inUse = await this.portsByHostname.values(Number);
        debug(`findFreePort(): these ports already in use`, inUse);
        return findPort({
            startingPort: 8000,
            endingPort: 9999,
            avoid: inUse
        }).catch(e => {
            throw Error(
                debug.errorMsg(
                    `Unable to find an open port. You may want to delete your database file at ${GlobalConfig.getDbFilePath()} to clear out old developer hostname entries. (Soon we will make this easier and more automatic.) Original error: ${e.toString()}`
                )
            );
        });
    }
    static async findFreeHostname(identifier, times = 0) {
        const maybeHostname =
            identifier + (times ? times : '') + '.local.pwadev';
        // if it has a port, it exists
        const exists = await this.portsByHostname.get(maybeHostname);
        if (!exists) {
            debug(
                `findFreeHostname: ${maybeHostname} unbound to port and available`
            );
            return maybeHostname;
        } else {
            debug(`findFreeHostname: ${maybeHostname} bound to port`, exists);
            return this.findFreeHostname(identifier, times + 1);
        }
    }
    static async provideDevHost(id) {
        debug(`provideDevHost('${id}')`);
        let hostname = await this.hostnamesById.get(id);
        let port;
        if (!hostname) {
            [hostname, port] = await Promise.all([
                this.findFreeHostname(id),
                this.findFreePort()
            ]);

            await this.hostnamesById.set(id, hostname);
            await this.portsByHostname.set(hostname, port);
        } else {
            port = await this.portsByHostname.get(hostname);
            if (!port) {
                throw Error(
                    debug.errorMsg(
                        `Found no port matching the hostname ${hostname}`
                    )
                );
            }
        }
        this.setLoopback(hostname);
        return {
            protocol: 'https:',
            hostname,
            port
        };
    }
    static async configure(config = {}) {
        debug('configure() invoked', config);
        this.validateConfig('.configure(config)', config);
        const devHost = await this.provideDevHost(config.id);
        const https = await SSLCertStore.provide(devHost.hostname);
        debug(`https provided:`, https);
        return {
            contentBase: false,
            compress: true,
            hot: true,
            https,
            host: devHost.hostname,
            port: devHost.port,
            publicPath: url.format(
                Object.assign({}, devHost, { pathname: config.publicPath })
            ),
            before(app) {
                // replace origins in links in returned html
                app.use(
                    middlewares.originSubstitution(
                        new url.URL(config.backendDomain),
                        devHost
                    )
                );
                // proxy to backend
                app.use(
                    middlewares.devProxy(config.backendDomain, {
                        passthru: ['js', 'map', 'css', 'json', 'svg']
                    })
                );
                // serviceworker root route
                app.use(
                    middlewares.staticRootRoute(
                        join(config.paths.output, config.serviceWorkerFileName)
                    )
                );
                // set static server to load and serve from different paths
                app.use(config.publicPath, express.static(config.paths.assets));
            }
        };
    }
}
module.exports = DevServer;